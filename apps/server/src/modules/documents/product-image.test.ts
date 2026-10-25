import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), locked: vi.fn(), download: vi.fn(), exports: vi.fn() }));
vi.mock('../../db/client.js', () => ({ db: { transaction: mocks.transaction } }));
vi.mock('./service.js', () => ({ lockedDocument: mocks.locked }));
vi.mock('./lingxing-image.js', () => ({ downloadLingxingImage: mocks.download }));
vi.mock('../batches/service.js', () => ({ BatchError: class extends Error { constructor(public code: string, public status: number, message: string) { super(message); } } }));
import { BatchError } from '../batches/service.js';
import { previewDocumentProductImage } from './product-image.js';

const input = { expectedVersion: 3, sid: 12, msku: 'M', fnsku: 'F', sku: 'S', url: 'https://images.example/product.png' };
const image = { imageBase64: 'preview bytes', imageExtension: 'png' as const };
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.transaction.mockImplementation(async (execute) => execute({ select: () => ({ from: () => ({ where: () => ({ limit: mocks.exports }) }) }) }));
  mocks.exports.mockResolvedValue([]);
  mocks.locked.mockResolvedValue({ record: { status: 'draft', version: 3 }, revision: { data: { members: [{ demand: { snapshot: { sid: 12 } }, shipment: { data: { items: [{ msku: 'M', fnsku: 'F', sku: 'S' }] } } }] } } });
  mocks.download.mockResolvedValue(image);
});
describe('read-only invoice product image preview', () => {
  it('binds the actor, version and full product identity before and after downloading without writes', async () => {
    expect(await previewDocumentProductImage('doc', 'admin', input)).toEqual({ image });
    expect(mocks.locked).toHaveBeenCalledTimes(2);
    expect(mocks.locked).toHaveBeenCalledWith(expect.anything(), 'doc', 'admin', 3);
    expect(mocks.download).toHaveBeenCalledWith(input.url);
  });
  it.each(['cancelled', 'superseded'])('refuses %s documents before making network requests', async (status) => {
    mocks.locked.mockResolvedValue({ record: { status }, revision: { data: { members: [] } } });
    await expect(previewDocumentProductImage('doc', 'admin', input)).rejects.toMatchObject({ code: 'DOCUMENT_READ_ONLY' });
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it('refuses existing files, unrelated products and stale versions before making network requests', async () => {
    mocks.exports.mockResolvedValueOnce([{ id: 'file' }]);
    await expect(previewDocumentProductImage('doc', 'admin', input)).rejects.toMatchObject({ code: 'DOCUMENT_CORRECTION_REQUIRED' });
    for (const changes of [{ sid: 13 }, { msku: 'different' }, { fnsku: '' }, { sku: '' }]) await expect(previewDocumentProductImage('doc', 'admin', { ...input, ...changes })).rejects.toMatchObject({ code: 'DOCUMENT_PRODUCT_SCOPE_MISMATCH' });
    mocks.locked.mockRejectedValueOnce(new BatchError('VERSION_CONFLICT', 409, 'Changed'));
    await expect(previewDocumentProductImage('doc', 'admin', input)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it('does not return bytes if the invoice changes while the request is in flight', async () => {
    mocks.locked.mockResolvedValueOnce(await mocks.locked()).mockRejectedValueOnce(new BatchError('VERSION_CONFLICT', 409, 'Changed'));
    await expect(previewDocumentProductImage('doc', 'admin', input)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
  it('returns clear controlled failures for blocked or unavailable images', async () => {
    mocks.download.mockRejectedValueOnce(new Error('图片地址不允许访问内网或保留地址。'));
    await expect(previewDocumentProductImage('doc', 'admin', input)).rejects.toMatchObject({ code: 'DOCUMENT_IMAGE_PREVIEW_FAILED', message: '图片地址不允许访问内网或保留地址。' });
    mocks.download.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(previewDocumentProductImage('doc', 'admin', input)).rejects.toMatchObject({ code: 'DOCUMENT_IMAGE_PREVIEW_FAILED', message: expect.stringContaining('无法获取图片') });
  });
});
