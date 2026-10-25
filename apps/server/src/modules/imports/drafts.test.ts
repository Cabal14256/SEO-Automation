import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IMPORT_DRAFT_MAX_FILE_BYTES, importDraftContentSchema, saveImportDraftInputSchema } from '@scm/contracts';

const progress = () => ({ importId: null, source: 'online' as const, step: 2 as const });
const content = () => ({ source: 'online' as const, progress: progress(), online: { rows: [{ fba: '', referenceQuantity: '尚未填写' }], startDate: '', endDate: '未定' } });
const file = (base64: string) => ({ source: 'file', progress: { importId: null, source: 'file' }, file: { name: '未提交.xlsx', lastModified: 0, type: '', base64 } });

describe('import draft validation', () => {
  it('preserves incomplete online rows, empty dates and request identities without creating an import', () => {
    const operationId = randomUUID();
    const result = saveImportDraftInputSchema.parse({ expectedVersion: 0, title: '  美国第一批  ', content: { ...content(), online: { ...content().online, operationId } } });
    expect(result.title).toBe('美国第一批');
    expect(result.content.online?.rows[0]).toMatchObject({ fba: '', shop: '', referenceQuantity: '尚未填写' });
    expect(result.content.online).toMatchObject({ startDate: '', endDate: '未定', operationId });
    expect(importDraftContentSchema.parse({ ...content(), online: { rows: [], startDate: '', endDate: '' } }).online?.rows).toEqual([]);
  });
  it('preserves API channel provenance in a saved draft so changing FBA can clear it', () => {
    const saved = importDraftContentSchema.parse({ ...content(), online: { ...content().online,
      rows: [{ fba: 'FBA123', channel: '美西海运专线' }], autofilled: [{ channel: '美西海运专线' }] } });
    expect(saved.online?.rows[0]?.channel).toBe('美西海运专线');
    expect(saved.online?.autofilled?.[0]?.channel).toBe('美西海运专线');
  });
  it('accepts exactly ten MiB and rejects larger, empty, malformed or noncanonical Base64', () => {
    expect(importDraftContentSchema.safeParse(file(Buffer.alloc(IMPORT_DRAFT_MAX_FILE_BYTES).toString('base64'))).success).toBe(true);
    expect(importDraftContentSchema.safeParse(file(Buffer.alloc(IMPORT_DRAFT_MAX_FILE_BYTES + 1).toString('base64'))).success).toBe(false);
    for (const encoded of ['', 'YQ', 'YQ===', 'Y Q==', 'data:application/xlsx;base64,YQ==', 'YR==', 'YWJ=']) {
      expect(importDraftContentSchema.safeParse(file(encoded)).success, encoded).toBe(false);
    }
    expect(importDraftContentSchema.safeParse(file('YQ==')).success).toBe(true);
    expect(importDraftContentSchema.safeParse(file('YWI=')).success).toBe(true);
  });
  it('retains an unresolved commit with its original operation and exact selected items', () => {
    const importId = randomUUID(), previewId = randomUUID();
    const pending = { operationId: randomUUID(), previewId, selectedItemIds: [randomUUID()], confirmedChangedItemIds: [] };
    const saved = importDraftContentSchema.parse({ ...content(), progress: { ...progress(), importId }, confirmation: { version: 1, importId, previewId, pending, lastOperationId: pending.operationId } });
    expect(saved.confirmation?.pending).toEqual(pending);
    expect(importDraftContentSchema.safeParse({ ...saved, confirmation: { ...saved.confirmation, importId: randomUUID() } }).success).toBe(false);
  });
  it('retains manual shop corrections and the optional baseline before a preview exists', () => {
    const importId = randomUUID(), sellerMappingId = randomUUID(), baselineImportId = randomUUID();
    const confirmation = { version: 1, importId, previewId: null, pending: null, lastOperationId: null, baselineImportId,
      shopSelections: { '来源店铺': { sellerMappingId, confirmed: true, confirmedVersion: 3, catalogSettingsVersion: 2, catalogVersion: 7 },
        '暂不采用': { sellerMappingId: '', confirmed: false } } };
    const saved = importDraftContentSchema.parse({ ...content(), progress: { ...progress(), importId }, confirmation });
    expect(saved.confirmation).toEqual(confirmation);
    expect(importDraftContentSchema.safeParse({ ...saved, confirmation: { ...confirmation,
      shopSelections: { '来源店铺': { ...confirmation.shopSelections['来源店铺'], confirmedVersion: 0 } } } }).success).toBe(false);
  });
  it('rejects mismatched source, blank title, negative versions and excessive rows', () => {
    expect(importDraftContentSchema.safeParse({ ...content(), progress: { ...progress(), source: 'file' } }).success).toBe(false);
    expect(saveImportDraftInputSchema.safeParse({ expectedVersion: 0, title: '  ', content: content() }).success).toBe(false);
    expect(saveImportDraftInputSchema.safeParse({ expectedVersion: -1, title: '草稿', content: content() }).success).toBe(false);
    expect(importDraftContentSchema.safeParse({ ...content(), online: { ...content().online, rows: Array.from({ length: 1001 }, () => ({})) } }).success).toBe(false);
  });
});
