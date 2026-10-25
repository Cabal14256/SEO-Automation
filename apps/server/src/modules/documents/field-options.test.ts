import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { documentFieldOptionsSchema } from '@scm/contracts';

const mocks = vi.hoisted(() => ({ requireActor: vi.fn(), limit: vi.fn(), orderBy: vi.fn() }));
vi.mock('../batches/service.js', () => ({ requireBatchActor: mocks.requireActor }));
vi.mock('../../db/client.js', () => ({ db: { transaction: async (action: (tx: unknown) => unknown) => action({ select: () => ({ from: () => ({ where: () => ({ orderBy: mocks.orderBy }) }) }) }) } }));
import { getDocumentFieldOptions, referenceServiceOptions } from './field-options.js';

const row = (name: string, extra: Record<string, unknown> = {}) => ({ values: { name, section: '美国' }, issues: [], cells: [{ type: ExcelJS.ValueType.String, formula: false }], ...extra });

beforeEach(() => {
  mocks.requireActor.mockReset(); mocks.limit.mockReset(); mocks.orderBy.mockReset();
  mocks.requireActor.mockResolvedValue({}); mocks.limit.mockResolvedValue([]); mocks.orderBy.mockReturnValue({ limit: mocks.limit });
});

describe('document service reference choices', () => {
  it('keeps unique service names while excluding invalid, formula and error reference rows', () => {
    expect(referenceServiceOptions({ rows: [row(' 服务甲 '), row('服务甲'), row('服务乙'), row(''),
      row('有问题', { issues: ['CHANNEL_REFERENCE_INCOMPLETE'] }),
      row('公式缓存', { cells: [{ type: ExcelJS.ValueType.Formula, formula: true }] }),
      row('错误值', { cells: [{ type: ExcelJS.ValueType.Error, formula: false }] }),
      row('其他列公式', { cells: [{ type: ExcelJS.ValueType.String, formula: false }, { type: ExcelJS.ValueType.Formula, formula: true }] }),
      { values: { name: '缺少证据' } }, null,
    ] })).toEqual(['服务甲', '服务乙']);
    expect(referenceServiceOptions(undefined)).toEqual([]);
    expect(referenceServiceOptions({ rows: 'invalid' })).toEqual([]);
  });

  it('returns only the latest catalog as options and leaves an absent catalog empty', async () => {
    const absent = await getDocumentFieldOptions('admin');
    expect(absent).toEqual({ services: [] });
    expect(mocks.requireActor).toHaveBeenCalledWith(expect.any(Object), 'admin');
    expect(mocks.orderBy).toHaveBeenCalledWith(expect.anything(), expect.anything());
    expect(mocks.limit).toHaveBeenCalledWith(1);
    mocks.limit.mockResolvedValueOnce([{ data: { rows: [row('丰信参考服务')] } }]);
    const available = await getDocumentFieldOptions('admin');
    expect(documentFieldOptionsSchema.parse(available)).toEqual({ services: ['丰信参考服务'] });
    expect(available).not.toHaveProperty('businessChannel');
    expect(available).not.toHaveProperty('currency');
  });

  it('checks the current actor before reading the catalog', async () => {
    mocks.requireActor.mockRejectedValueOnce(new Error('inactive actor'));
    await expect(getDocumentFieldOptions('old-admin')).rejects.toThrow('inactive actor');
    expect(mocks.orderBy).not.toHaveBeenCalled();
  });
});
