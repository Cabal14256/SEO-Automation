import { Decimal } from 'decimal.js';
import { expect, it } from 'vitest';
import { customsExcelNumberSafe } from './domain.js';

it('accepts ordinary exact decimal business values for numeric XLSX cells', () => {
  expect(customsExcelNumberSafe(new Decimal('123456.123456'))).toBe(true);
  expect(customsExcelNumberSafe(new Decimal('0.3'))).toBe(true);
});
it('does not silently publish totals whose significant digits are lost in Excel', () => {
  expect(customsExcelNumberSafe(new Decimal('999999999999999.12'))).toBe(false);
  expect(customsExcelNumberSafe(new Decimal('9007199254740991'))).toBe(false);
});
