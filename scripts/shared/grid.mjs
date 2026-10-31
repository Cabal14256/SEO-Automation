// Exercise the same row navigation and DOM details used by keyboard users.
// Canvas rows are intentionally not duplicated as a hidden HTML table.
import { expect } from '@playwright/test';
export const grid = (scope, label) => scope.locator(`[data-grid-label=${JSON.stringify(label)}]`);
export const activeGridRow = (scope, label) => grid(scope, label).getByRole('region', { name: `${label} 当前记录`, exact: true });

export async function closeGridMenu(scope, label) {
  const menu = grid(scope, label).page().getByRole('menu', { name: `${label} 行操作`, exact: true });
  if (await menu.isVisible()) { await menu.press('Escape'); await expect(menu).not.toBeVisible(); }
}

export async function showShippingFilters(scope) {
  const show = scope.getByRole('button', { name: '展示过滤条件', exact: true });
  const hide = scope.getByRole('button', { name: '隐藏过滤条件', exact: true });
  await show.or(hide).first().waitFor({ state: 'visible' });
  if (await show.isVisible()) await show.click();
}

export async function closeGridDetails(scope, label) {
  const dialog = grid(scope, label).locator('dialog.scm-grid-dialog[open]');
  if (await dialog.count()) {
    await dialog.locator(':scope > .import-dialog-heading button').click();
    await expect(dialog).toHaveCount(0);
  }
}

export async function gridRowCount(scope, label) {
  const target = grid(scope, label);
  return await target.count() ? Number(await target.getAttribute('data-row-count')) : 0;
}

export async function selectGridRow(scope, label, index) {
  const target = grid(scope, label);
  await target.waitFor({ state: 'visible' });
  await closeGridMenu(scope, label);
  await closeGridDetails(scope, label);
  const viewport = target.getByRole('grid');
  await viewport.waitFor({ state: 'visible' });
  await expect(viewport).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
  await target.getByRole('spinbutton', { name: `${label} 定位行`, exact: true }).fill(String(index + 1));
  const details = target.getByRole('button', { name: `${label} 查看当前记录`, exact: true });
  if (await details.count()) {
    await details.click();
    if (await details.getAttribute('aria-haspopup') === 'menu') await target.page().getByRole('menu', { name: `${label} 行操作`, exact: true }).getByRole('menuitem', { name: '完整详情', exact: true }).click();
  }
  await expect(activeGridRow(scope, label)).toHaveAttribute('data-grid-row-index', String(index + 1));
  return activeGridRow(scope, label);
}

export async function findGridRow(scope, label, text, { allowMissing = false } = {}) {
  const target = grid(scope, label);
  if (allowMissing && !await target.count()) return activeGridRow(scope, label).filter({ hasText: text });
  await target.waitFor({ state: 'visible' });
  const active = activeGridRow(scope, label).filter({ hasText: text });
  if (await active.count()) return active;
  const count = await gridRowCount(scope, label);
  for (let index = 0; index < count; index++) {
    const row = await selectGridRow(scope, label, index);
    if (await row.filter({ hasText: text }).count()) return row.filter({ hasText: text });
  }
  return activeGridRow(scope, label).filter({ hasText: text });
}
