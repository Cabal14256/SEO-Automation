// Select through the rendered control so browser checks exercise its actual UI.
// The native branch also supports scripts run against older application builds.
export async function chooseOption(control, value) {
  if (await control.evaluate((node) => node.tagName === 'SELECT')) {
    await control.selectOption(String(value));
    return;
  }
  await control.click();
  const option = control.page().locator(`[role="option"][data-option-value=${JSON.stringify(String(value))}]:visible`);
  await option.waitFor({ state: 'visible' });
  await option.click();
}

export async function readOptions(control) {
  if (await control.evaluate((node) => node.tagName === 'SELECT')) {
    return control.locator('option').evaluateAll((nodes) => nodes.map((node) => node.value));
  }
  await control.click();
  const options = control.page().locator('[role="option"][data-option-value]:visible');
  await options.first().waitFor({ state: 'visible' });
  const values = await options.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-option-value')));
  await control.page().keyboard.press('Escape');
  await options.first().waitFor({ state: 'hidden' });
  return values;
}
