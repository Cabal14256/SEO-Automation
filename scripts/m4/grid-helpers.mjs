import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { closeGridDetails, closeGridMenu, grid } from '../shared/grid.mjs';

export const visibleColumnKeys = async (scope, label) => JSON.parse(await grid(scope, label).getAttribute('data-grid-column-keys'));
export const rowMenu = (scope, label) => scope.page().getByRole('menu', { name: `${label} 行操作`, exact: true });

export async function openRowMenu(scope, label, index = 0) {
  const target = grid(scope, label);
  await closeGridMenu(scope, label); await closeGridDetails(scope, label);
  await expect(target.getByRole('grid')).toHaveAttribute('aria-busy', 'false');
  await target.getByRole('spinbutton', { name: `${label} 定位行`, exact: true }).fill(String(index + 1));
  await target.getByRole('button', { name: `${label} 查看当前记录`, exact: true }).click();
  const menu = rowMenu(scope, label); await expect(menu).toBeVisible(); return menu;
}

export async function setColumnVisible(scope, label, title, key, shown) {
  const target = grid(scope, label), page = scope.page();
  await closeGridMenu(scope, label); await closeGridDetails(scope, label);
  await target.getByRole('button', { name: '列展示设置', exact: true }).click();
  const picker = page.locator('.scm-column-picker:visible');
  await picker.getByRole('textbox', { name: '查找列', exact: true }).fill(title);
  await picker.getByRole('checkbox', { name: title, exact: true }).setChecked(shown);
  await expect.poll(() => visibleColumnKeys(scope, label).then((keys) => keys.includes(key))).toBe(shown);
  await picker.press('Escape'); await expect(picker).not.toBeVisible();
}

export async function assertBottomNavigation(scope, label) {
  const target = grid(scope, label), canvas = await target.getByRole('grid').boundingBox();
  const navigation = await target.getByRole('spinbutton', { name: `${label} 定位行`, exact: true }).boundingBox();
  assert(canvas && navigation && navigation.y >= canvas.y + canvas.height - 1, `${label}: row navigation is below the Canvas`);
}

// Use the grid's supported keyboard navigation to reach a stable visible key.
// This remains valid when optional columns before the requested field are hidden.
export async function editGridCell(scope, label, rowIndex, columnKey, inputLabel) {
  await closeGridMenu(scope, label); await closeGridDetails(scope, label);
  const target = grid(scope, label), canvas = target.getByRole('grid');
  const keys = await visibleColumnKeys(scope, label), index = keys.indexOf(columnKey);
  assert(index >= 0, `Editable column ${columnKey} must be visible`);
  await target.getByRole('spinbutton', { name: `${label} 定位行`, exact: true }).fill(String(rowIndex + 1));
  await canvas.focus();
  for (let offset = 0; offset < keys.length; offset++) await canvas.press('ArrowLeft');
  for (let offset = 0; offset < index; offset++) await canvas.press('ArrowRight');
  await canvas.press('Enter');
  const input = scope.getByRole('textbox', { name: inputLabel, exact: true }); await expect(input).toBeFocused(); return input;
}
