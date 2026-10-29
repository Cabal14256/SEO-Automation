import { createHash, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import type { BatchTx } from '../batches/service.js';
import { documentReferenceDatasets } from './reference-schema.js';

const mocks = vi.hoisted(() => ({ select: vi.fn(), operation: vi.fn(), checked: vi.fn(), writeProfile: vi.fn() }));
vi.mock('../../db/client.js', () => ({ db: { select: mocks.select } }));
vi.mock('../batches/service.js', () => ({ BatchError: class extends Error { constructor(public code: string, public status: number, message: string) { super(message); } }, requireBatchActor: vi.fn() }));
vi.mock('../batches/report-service.js', () => ({ publishReportFile: vi.fn() }));
vi.mock('../imports/service.js', () => ({ checkedFileBytes: mocks.checked }));
vi.mock('./service.js', () => ({ documentOperation: mocks.operation, writeDocumentProfileInTx: mocks.writeProfile }));
import { importReferenceWorkbook } from './reference-import.js';

function query(rows: unknown[]) {
  const result = Object.assign(Promise.resolve(rows), { from: () => result, innerJoin: () => result, where: () => result, limit: () => result });
  return result;
}

describe('reference workbook archive with Lingxing-only addresses', () => {
  it('archives address and channel evidence without creating or looking up local address profiles', async () => {
    const workbook = new ExcelJS.Workbook(), addresses = workbook.addWorksheet('地址库');
    addresses.addRows([
      ['地址简称*', '地址编码*', 'FBA仓库代码', '联系人*', '公司名', '联系电话', '联系手机', '地址一*', '地址二', '地址三', '城市*', '省/洲', '国家*', '邮编*'],
      ['测试地址', 'ADDR1', 'TEST1', '测试收件人', '', '', '', '10 Example Road', '', '', 'Example City', 'CA', 'US', '00123'],
    ]);
    workbook.addWorksheet('发货渠道').addRows([['渠道名称', '板块'], ['示例渠道', '示例板块']]);
    workbook.addWorksheet('报关方式').addRow(['普通报关']);
    workbook.addWorksheet('预计送仓数据').addRows([['', '渠道', 'FBA仓库代码', '预计送仓时效', '区域'], ['', '示例渠道', 'TEST1', '12-15', '测试区']]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer()), sha256 = createHash('sha256').update(bytes).digest('hex'), fileId = randomUUID();
    mocks.select.mockReturnValueOnce(query([])).mockReturnValueOnce(query([{ file: { id: fileId } }]));
    mocks.checked.mockResolvedValue(bytes);
    const reads: unknown[] = [], writes: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: () => ({ from: (table: unknown) => { reads.push(table); return query([]); } }),
      insert: (table: unknown) => ({ values: async (values: Record<string, unknown>) => { writes.push({ table, values }); } }),
    } as unknown as BatchTx;
    mocks.operation.mockImplementation(async (_actor: string, _id: string, _action: string, _input: unknown, work: (transaction: BatchTx) => Promise<object>) => ({ ...await work(tx), replayed: false }));

    const result = await importReferenceWorkbook({ actorId: 'fixture', operationId: randomUUID(), bytes, originalName: 'synthetic-reference.xlsx', expectedSha256: sha256 });

    expect(result.addressProfiles).toEqual([]);
    expect(result.summary).toMatchObject({ addressRecordCount: 1, addressProfileCount: 0, channelRecordCount: 1 });
    expect(result.datasets.map((entry) => entry.kind)).toEqual(['address_catalog', 'channel_catalog', 'customs_options', 'transit_reference']);
    expect(result.sourceFileId).toBe(fileId);
    expect(reads.every((table) => table === documentReferenceDatasets)).toBe(true);
    expect(writes.every(({ table }) => table === documentReferenceDatasets)).toBe(true);
    expect(writes.find(({ values }) => values.kind === 'address_catalog')?.values.data).toMatchObject({ rows: [expect.objectContaining({ values: expect.objectContaining({ addressLine1: '10 Example Road' }) })] });
    expect(writes.find(({ values }) => values.kind === 'channel_catalog')?.values.data).toMatchObject({ rows: [expect.objectContaining({ values: expect.objectContaining({ name: '示例渠道' }) })] });
    expect(mocks.writeProfile).not.toHaveBeenCalled();
  });
});
