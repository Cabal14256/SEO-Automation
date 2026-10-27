import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { candidates, git, inside, knownValues, privatePath, scanContent, scanFiles, scanHistory } from './core.mjs';
import { exportPublic } from './export.mjs';

async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'scm-privacy-'));
  try {
    const repo = join(root, 'source'); await mkdir(repo);
    await git(repo, ['init', '--initial-branch=main']);
    await git(repo, ['config', 'user.name', 'Privacy Test']);
    await git(repo, ['config', 'user.email', 'privacy-test@example.invalid']);
    await action(root, repo);
  } finally { assert(inside(tmpdir(), root)); await rm(root, { recursive: true, force: true }); }
}
async function file(repo, path, text) {
  const target = join(repo, path); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, text);
}
async function commit(repo, message = 'Synthetic fixture') {
  await git(repo, ['add', '--all']); await git(repo, ['-c', 'commit.gpgSign=false', 'commit', '-m', message]);
}
test('public boundaries reject all private files while preserving other public directory notices', () => {
  for (const path of ['docs/research/README.md', 'docs/acceptance/evidence/README.md', '.env.example', 'apps/server/src/parser.test.ts']) assert.equal(privatePath(path), false, path);
  for (const path of ['docs/research/any/raw.md', 'docs/acceptance/evidence/screenshot.png', 'docs/private/README.md', 'docs/private/nested/example.md', 'docs\\private\\README.md', 'docs/private/source.xlsx', 'docs/templates/import.xlsx', '.local/privacy/known-values.json', 'apps/server/.env', 'scripts/probe.local.json', 'archive.zip', 'database.sqlite3-wal', 'apps/server/dist/api.js']) assert.equal(privatePath(path), true, path);
});
test('patterns and private manifest catch identifiers without printing matching content', () => {
  const shipment = `FBA${'1A2B3C4D5E'}`;
  const asin = `B0${'1A2B3C4D'}`;
  const fnsku = `X00${'1A2B3C4'}`;
  const marker = ['Private', 'Seller'].join(' ');
  const bytes = Buffer.from(`header\n${shipment} ${asin} ${fnsku}\n${marker}\nsid: 9091\nnotSid: 190919\n`);
  const findings = scanContent('fixture.ts', bytes, [marker, '9091']);
  assert.equal(findings.filter((item) => item.rule === 'private-known-value').length, 2);
  assert.equal(findings.filter((item) => /identifier$/.test(item.rule)).length, 3);
  assert(!JSON.stringify(findings).includes(shipment)); assert(!JSON.stringify(findings).includes(marker));
  assert.deepEqual(scanContent('demo.ts', Buffer.from('FBADEMO00001 FBATEST00001 B0TEST0001 test@example.invalid')), []);
  assert.equal(scanContent('fixture.ts', Buffer.from(marker.toUpperCase()), [marker]).at(0).rule, 'private-known-value');
  const fullwidth = marker.replace(/[A-Za-z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 0xfee0));
  assert.equal(scanContent('fixture.ts', Buffer.from(fullwidth), [marker]).at(0).rule, 'private-known-value');
  assert.equal(scanContent('fixture.ts', Buffer.from(`İ\n${fullwidth.toLowerCase()}\n`), [marker]).at(0).line, 2);
  assert.equal(scanContent('fixture.ts', Buffer.from(shipment.toLowerCase())).at(0).rule, 'shipment-identifier');
  const fullwidthShipment = shipment.replace(/[A-Za-z0-9]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 0xfee0));
  assert.equal(scanContent('fixture.ts', Buffer.from(fullwidthShipment)).at(0).rule, 'shipment-identifier');
});
test('credential and binary checks allow explicit placeholders and reject real-shaped tokens', () => {
  assert.equal(scanContent('file', Buffer.from([0xff, 0xd8, 0xff])).at(0).rule, 'unreviewed-binary');
  const token = `ghp_${'A'.repeat(36)}`;
  assert.equal(scanContent('file', Buffer.from(token)).at(0).rule, 'access-token');
  assert.equal(scanContent('file', Buffer.from(`CLIENT_SECRET=${'a'.repeat(32)}`)).at(0).rule, 'credential-literal');
  assert.equal(scanContent('file.json', Buffer.from(JSON.stringify({ accessToken: 'a'.repeat(32) }))).at(0).rule, 'credential-literal');
  assert.deepEqual(scanContent('.env.example', Buffer.from('CLIENT_SECRET=replace-with-your-own-secret-0000\nCONTACT=demo@example.invalid')), []);
  const upstreamContact = ['maintainer', 'upstream.dev'].join('@');
  assert.deepEqual(scanContent('pnpm-lock.yaml', Buffer.from(`  deprecated: Contact ${upstreamContact}`)), []);
  assert.equal(scanContent('pnpm-lock.yaml', Buffer.from(`  custom: ${upstreamContact}`)).at(0).rule, 'contact-email');
  const publicIdentity = 'synthetic@users.noreply.github.com';
  assert.deepEqual(scanContent('commit', Buffer.from(publicIdentity)), []);
  assert.equal(scanContent('commit', Buffer.from(publicIdentity), [publicIdentity]).at(0).rule, 'private-known-value');
});
test('GitHub web-commit bot identity is public while other contacts remain blocked', () => {
  const bot = 'noreply@github.com';
  assert.deepEqual(scanContent('commit', Buffer.from(`committer GitHub <${bot}>`)), []);
  assert.equal(scanContent('commit', Buffer.from(bot), [bot]).at(0).rule, 'private-known-value');
  const contact = ['maintainer', 'github.com'].join('@');
  assert.equal(scanContent('commit', Buffer.from(contact)).at(0).rule, 'contact-email');
  assert.equal(scanContent('commit', Buffer.from(bot + '.untrusted.dev')).at(0).rule, 'contact-email');
});
test('repository scan covers tracked ignored artifacts and untracked public files', () => fixture(async (_, repo) => {
  await file(repo, 'docs/research/raw.md', 'private input'); await commit(repo);
  await file(repo, '.gitignore', 'docs/research/**\n.local/\n');
  await file(repo, 'new-source.ts', 'export const synthetic = true;');
  await file(repo, '.local/privacy/known-values.json', JSON.stringify({ format: 'scm-private-values/v1', values: ['Synthetic Hidden Name'] }));
  const files = await candidates(repo);
  assert(files.includes('new-source.ts')); assert(!files.includes('.local/privacy/known-values.json'));
  assert.equal((await knownValues(repo)).length, 1);
  assert((await scanFiles(repo, files)).some((finding) => finding.rule === 'private-or-generated-path'));
}));
test('history inspection catches a private source removed from the current tree', () => fixture(async (_, repo) => {
  await file(repo, 'docs/research/raw.md', 'private input'); await commit(repo);
  await rm(join(repo, 'docs/research/raw.md')); await file(repo, 'source.ts', 'export {};'); await commit(repo);
  assert.deepEqual(await scanFiles(repo, await candidates(repo)), []);
  assert((await scanHistory(repo)).findings.some((finding) => finding.rule === 'private-history-path'));
}));
test('only the exact previously published private-directory notice is allowed in history', () => fixture(async (_, repo) => {
  // Previously public text only; business examples must never become fixtures.
  const notice = '# 受控业务资料\n\n此目录用于本地受控业务文件，不随公开仓库发布。原始工作簿、SOP、发票、报关、物流资料和图片可能含公司、店铺、商品、地址、联系人、税务及交易数据；目录中除本说明外的内容均由版本控制和公开导出排除。\n\n应用数据应放在项目外的 `DATA_DIR`，凭据放在未跟踪的环境配置中。公开测试和文档仅使用独立编造的示例。不要把真实原件换个名称当成脱敏文件，也不要把原件哈希、截图或解压后的 XML 放入公开目录。\n\n本次处理前的原件已保留在项目外的私有备份目录；具体路径由本地维护记录管理，公开仓库不提供来源文件清单。\n';
  await file(repo, 'docs/private/README.md', notice); await commit(repo);
  assert((await scanFiles(repo, await candidates(repo))).some((finding) => finding.rule === 'private-or-generated-path'));
  assert.deepEqual((await scanHistory(repo)).findings, []);
  const marker = ['受控', '业务资料'].join('');
  assert((await scanHistory(repo, [marker])).findings.some((finding) => finding.rule === 'private-known-value'));
  await file(repo, 'docs/private/README.md', notice + '\nNew local example\n'); await commit(repo);
  assert((await scanHistory(repo)).findings.some((finding) => finding.rule === 'private-history-path'));
}));
test('public export excludes a tracked private README even when no ignore rule exists', () => fixture(async (root, repo) => {
  await file(repo, 'source.ts', 'export {};');
  await file(repo, 'docs/private/README.md', 'Local business example'); await commit(repo);
  const out = join(root, 'public'); const report = await exportPublic({ repo, out });
  assert.equal(report.result, 'passed');
  assert(!(await candidates(out)).some((path) => path.startsWith('docs/private/')));
}));
test('private filenames are blocked and redacted from working tree and history reports', () => fixture(async (_, repo) => {
  const marker = ['Synthetic', 'SensitiveName'].join('-');
  const path = `${marker}.md`; await file(repo, path, 'safe contents'); await commit(repo);
  const report = await scanFiles(repo, await candidates(repo), [marker]);
  assert.equal(report.at(0).rule, 'sensitive-filename'); assert(!JSON.stringify(report).includes(marker));
  const history = await scanHistory(repo, [marker]);
  assert(history.findings.some((finding) => finding.rule === 'sensitive-history-filename'));
  assert(!JSON.stringify(history).includes(marker));
}));
test('public export omits private files and creates one independent commit with no remote', () => fixture(async (root, repo) => {
  await file(repo, '.gitignore', '.local/\ndocs/research/**\n');
  await file(repo, 'source.ts', 'export const synthetic = true;'); await commit(repo);
  await file(repo, 'source.ts', 'export const synthetic = false;'); await commit(repo);
  await file(repo, 'docs/research/raw.md', 'ignored private input');
  await file(repo, 'new-source.ts', 'export {};');
  const oldHead = await git(repo, ['rev-parse', 'HEAD']);
  const out = join(root, 'public'); const report = await exportPublic({ repo, out });
  assert.equal(report.result, 'passed'); assert.equal((await git(out, ['rev-list', '--count', 'HEAD'])).toString().trim(), '1');
  assert.equal((await git(out, ['remote'])).toString().trim(), '');
  assert.deepEqual(await git(repo, ['rev-parse', 'HEAD']), oldHead);
  assert.equal(await readFile(join(out, 'new-source.ts'), 'utf8'), 'export {};');
  assert(!(await candidates(out)).includes('docs/research/raw.md'));
  await assert.rejects(exportPublic({ repo, out }), /already exists/);
  await assert.rejects(exportPublic({ repo, out: join(repo, 'public') }), /outside/);
}));
test('public export refuses source containing private identifiers before creating output', () => fixture(async (root, repo) => {
  const marker = ['Synthetic', 'Blocked Seller'].join(' ');
  await file(repo, '.gitignore', '.local/\n');
  await file(repo, 'source.ts', JSON.stringify(marker));
  await file(repo, '.local/privacy/known-values.json', JSON.stringify({ format: 'scm-private-values/v1', values: [marker] }));
  const report = await exportPublic({ repo, out: join(root, 'public') });
  assert.equal(report.result, 'failed'); assert.equal(report.created, false);
  assert(!JSON.stringify(report).includes(marker));
}));
test('directory junctions cannot expose private files outside the repository', () => fixture(async (root, repo) => {
  await file(repo, 'linked/source.ts', 'export {};'); await commit(repo);
  const outside = join(root, 'private'); await mkdir(outside); await writeFile(join(outside, 'source.ts'), 'external private input');
  assert(inside(repo, join(repo, 'linked'))); await rm(join(repo, 'linked'), { recursive: true });
  await symlink(outside, join(repo, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const findings = await scanFiles(repo, await candidates(repo));
  // Git reports the new symlink itself on Linux; Windows junctions instead expose
  // the tracked child. Both must block export before any output is created.
  assert(findings.some((finding) => ['linked', 'linked/source.ts'].includes(finding.path)
    && ['nonregular-file', 'linked-source-outside-repository'].includes(finding.rule)));
  const out = join(root, 'public');
  await exportPublic({ repo, out }).then((report) => {
    assert.equal(report.result, 'failed'); assert.equal(report.created, false);
  }, (error) => {
    // Linux Git can refuse check-ignore on the tracked child beyond a symlink.
    assert(error instanceof Error); assert.equal(error.message, 'Git operation failed (128)');
  });
  await assert.rejects(lstat(out), { code: 'ENOENT' });
}));
