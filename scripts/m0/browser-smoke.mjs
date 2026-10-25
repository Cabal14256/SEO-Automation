import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// This suite talks to the running application and its real development database.
// It never replaces API responses or stores browser sessions in its report.
const { chromium } = await import(process.env.M0_PLAYWRIGHT_MODULE || '@playwright/test');
const baseURL = process.env.M0_BASE_URL || 'http://localhost:3001';
const evidenceDir = resolve(process.env.M0_BROWSER_EVIDENCE_DIR || '.local/m0/browser');
const mode = process.env.M0_BROWSER_MODE || 'healthy';
const credentialsPath = process.env.M0_CREDENTIALS_FILE;
const checks = [];
const errors = [];
let currentStep = 'browser setup';
const report = { kind: 'real-postgresql-browser-e2e', mode, baseURL, timeZone: 'Asia/Shanghai', startedAt: new Date().toISOString(), checks };

await mkdir(evidenceDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.M0_BROWSER_CHANNEL ? { channel: process.env.M0_BROWSER_CHANNEL } : {}),
});
report.browserVersion = browser.version();
const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(error.name));

function record(name, detail = {}) {
  checks.push({ name, result: 'passed', ...detail });
  currentStep = 'next acceptance step';
  console.log(`PASS ${name}`);
}

async function waitUntil(check, message, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(message);
}

async function signIn(account) {
  currentStep = 'login page';
  assert.ok(account?.email && account?.password, '缺少本地验收账号');
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(account.email);
  await page.getByLabel('密码', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  currentStep = 'login response';
  await page.getByRole('heading', { name: '发货任务工作台', exact: true }).waitFor();
}

async function signOut() {
  currentStep = 'sign out';
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  currentStep = 'verify signed-out session';
  await page.getByRole('heading', { name: '登录发货协同', exact: true }).waitFor();
  const response = await context.request.get('/api/v1/session');
  assert.equal(response.status(), 200);
  assert.equal((await response.json()).user, null);
}

try {
  if (mode === 'outage') {
    currentStep = 'database outage health';
    const health = await context.request.get('/api/v1/health');
    assert.equal(health.status(), 503);
    assert.equal((await health.json()).database, 'error');
    await page.goto('/');
    currentStep = 'database outage UI';
    await page.getByRole('heading', { name: '无法打开工作台', exact: true }).waitFor();
    await page.getByText('数据库连接失败，请检查数据库服务后重试。', { exact: true }).waitFor();
    assert.equal(await page.getByText('数据库在线', { exact: true }).count(), 0);
    await page.screenshot({ path: resolve(evidenceDir, 'database-outage.png'), fullPage: true });
    record('真实数据库不可用：健康接口 503，页面显示数据库故障');
  } else {
    currentStep = 'credentials setup';
    assert.equal(mode, 'healthy', 'M0_BROWSER_MODE 仅支持 healthy / outage');
    assert.ok(credentialsPath, '请通过 M0_CREDENTIALS_FILE 指定本地受控账号 JSON 文件');
    const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
    const health = await context.request.get('/api/v1/health');
    assert.equal(health.status(), 200);
    assert.equal((await health.json()).database, 'ok');
    record('真实数据库健康接口');

    assert.deepEqual(Object.keys(credentials), ['admin'], '本地凭据文件只应保留管理员');
    for (const role of ['admin']) {
      await signIn(credentials[role]);
      const session = await context.request.get('/api/v1/session');
      assert.equal((await session.json()).user.role, role);
      await signOut();
      record(`${role} 页面登录和退出`);
    }

    await page.getByLabel('邮箱', { exact: true }).fill(credentials.admin.email);
    await page.getByLabel('密码', { exact: true }).fill('M0-invalid-password-do-not-use');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '邮箱或密码不正确。' }).waitFor();
    assert.equal((await (await context.request.get('/api/v1/session')).json()).user, null);
    record('错误密码被拒绝且显示反馈');

    await signIn(credentials.admin);
    currentStep = 'demo task creation';
    const label = `M0 浏览器验收 ${new Date().toISOString()}`;
    await page.getByLabel('任务名称', { exact: true }).fill(label);
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '任务已保存' }).waitFor();
    let taskId;
    await waitUntil(async () => {
      const response = await context.request.get('/api/v1/tasks');
      assert.equal(response.status(), 200);
      const task = (await response.json()).items.find((item) => item.label === label);
      taskId = task?.id;
      return task?.status === 'completed' && task.result;
    }, '真实 Worker 未在 45 秒内完成浏览器提交的任务');
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    const row = page.getByRole('row').filter({ hasText: label });
    await row.getByText('已完成', { exact: true }).waitFor();
    await row.getByText('任务已完成', { exact: true }).waitFor();
    record('页面提交 → 真实持久任务 → Worker 完成 → 查询结果', { taskId });

    for (const width of [320, 390, 1024]) {
      currentStep = `responsive viewport ${width}px`;
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole('heading', { name: '发货任务工作台', exact: true }).waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert.equal(overflow, false, `${width}px 页面产生整体横向溢出`);

      if (width < 768) {
        await page.getByRole('button', { name: '打开导航', exact: true }).click();
        const navigation = page.locator('#mobile-navigation');
        await navigation.getByRole('link', { name: '工作台', exact: true }).click();
        assert.equal(await navigation.count(), 0);
      } else {
        await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
        await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
      }

      const input = page.getByLabel('任务名称', { exact: true });
      await input.focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.getByRole('button', { name: '创建任务', exact: true }).evaluate((node) => node === document.activeElement), true);
      const focusedOutline = await page.getByRole('button', { name: '创建任务', exact: true }).evaluate((node) => getComputedStyle(node).outlineStyle);
      assert.notEqual(focusedOutline, 'none');

      const table = page.getByRole('region', { name: '任务记录表，可横向滚动', exact: true });
      await table.focus();
      const scrollable = await table.evaluate((node) => node.scrollWidth > node.clientWidth);
      if (scrollable) {
        await page.keyboard.press('ArrowRight');
        await waitUntil(() => table.evaluate((node) => node.scrollLeft > 0), `${width}px 表格不能使用键盘横向滚动`, 3_000);
        await table.evaluate((node) => { node.scrollLeft = 0; });
      }

      await input.fill(`M0 响应式验收 ${width}px`);
      await page.getByRole('button', { name: '创建任务', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '任务已保存' }).waitFor();
      assert.equal(await input.inputValue(), '');
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: resolve(evidenceDir, `dashboard-${width}.png`), fullPage: true });
      record(`${width}px 导航、焦点、表格和任务操作`, { tableScrollable: scrollable });
    }
    await signOut();
  }
  assert.deepEqual(errors, [], '浏览器出现未捕获错误');
  record('浏览器未出现未捕获 JavaScript 错误');
  report.result = 'passed';
} catch (error) {
  report.result = 'failed';
  // Locator diagnostics can include populated form values. Keep them out of logs.
  report.failure = { step: currentStep, error: error instanceof assert.AssertionError ? error.message : error?.name || 'Error' };
  console.error('FAIL M0 browser acceptance; inspect the controlled local report.');
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(evidenceDir, `browser-${mode}.json`), JSON.stringify(report, null, 2));
  await browser.close();
}
