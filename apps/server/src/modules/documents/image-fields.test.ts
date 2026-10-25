import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_PRODUCT_IMAGE_MAX_BYTES, documentCorrectInputSchema, documentCreateInputSchema, documentFieldsSchema, documentProductImageInfo, documentProductImageSchema, documentRevisionInputSchema } from '@scm/contracts';
import { assertDocumentImageChanges, assertProductImageChange } from './image-fields.js';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const key = `product.${'a'.repeat(64)}.imageBase64`;
function paddedPng(size: number) {
  const bytes = Buffer.from(pixel, 'base64'), chunk = Buffer.alloc(size - bytes.length);
  chunk.writeUInt32BE(chunk.length - 12); chunk.write('tEXt', 4);
  return Buffer.concat([bytes.subarray(0, -12), chunk, bytes.subarray(-12)]).toString('base64');
}
describe('manual product image boundary', () => {
  it('recognizes complete PNG/data URLs and rejects invalid, truncated or extension-disguised images', () => {
    expect(documentProductImageInfo(pixel)).toMatchObject({ extension: 'png', width: 1, height: 1, byteLength: 68 });
    expect(documentProductImageInfo(`data:image/png;base64,${pixel}`)?.base64).toBe(pixel);
    for (const value of ['bad', pixel.slice(0, -4), Buffer.from([255, 216, 255, 217]).toString('base64'), `data:image/jpeg;base64,${pixel}`]) expect(documentProductImageInfo(value)).toBeNull();
    expect(documentProductImageSchema.safeParse({ imageBase64: pixel, imageExtension: 'png' }).success).toBe(true);
    expect(documentProductImageSchema.safeParse({ imageBase64: pixel, imageExtension: 'jpeg' }).success).toBe(false);
  });
  it('opens only canonical image keys beyond 4000 characters and enforces per-image and whole-ticket budgets', () => {
    const image = paddedPng(4096), maxImage = paddedPng(DOCUMENT_PRODUCT_IMAGE_MAX_BYTES);
    expect(documentFieldsSchema.safeParse({ [key]: image }).success).toBe(true);
    expect(documentFieldsSchema.safeParse({ remarks: image }).success).toBe(false);
    expect(documentFieldsSchema.safeParse({ 'product.short.imageBase64': image }).success).toBe(false);
    expect(documentProductImageInfo(maxImage)?.byteLength).toBe(DOCUMENT_PRODUCT_IMAGE_MAX_BYTES);
    expect(documentProductImageInfo(paddedPng(DOCUMENT_PRODUCT_IMAGE_MAX_BYTES + 1))).toBeNull();
    expect(documentFieldsSchema.safeParse({ [key]: paddedPng(DOCUMENT_PRODUCT_IMAGE_MAX_BYTES + 1) }).success).toBe(false);
    const fields = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`product.${String(index).repeat(64)}.imageBase64`, maxImage]));
    expect(documentFieldsSchema.safeParse(fields).success).toBe(true);
    expect(documentFieldsSchema.safeParse({ ...fields, [key]: maxImage }).success).toBe(false);
  });
  it('uses the capacity schema consistently for creation, revisions and corrections', () => {
    const fields = { [key]: paddedPng(4096) }, operationId = randomUUID(), demandIds = [randomUUID()];
    expect(documentCreateInputSchema.safeParse({ operationId, demandIds, weekStartDate: '2026-10-19', title: 'Image', fields }).success).toBe(true);
    expect(documentRevisionInputSchema.safeParse({ operationId, expectedVersion: 1, reason: 'Image', fields }).success).toBe(true);
    expect(documentCorrectInputSchema.safeParse({ operationId, expectedVersion: 1, demandIds, reason: 'Image', fields }).success).toBe(true);
  });
  it('preserves unchanged legacy invalid images while requiring valid new or replaced content', () => {
    const previous = { [key]: 'legacy invalid', remarks: 'Old' };
    expect(documentFieldsSchema.safeParse(previous).success).toBe(true);
    expect(() => assertDocumentImageChanges(previous, { ...previous, remarks: 'New' })).not.toThrow();
    expect(() => assertDocumentImageChanges({}, previous)).toThrow('新增或替换');
    expect(() => assertDocumentImageChanges(previous, { [key]: 'another invalid' })).toThrow('新增或替换');
    expect(() => assertDocumentImageChanges(previous, { [key]: pixel })).not.toThrow();
    for (const blank of ['', null]) expect(() => assertDocumentImageChanges(previous, { [key]: blank })).not.toThrow();
    expect(previous[key]).toBe('legacy invalid');
    expect(() => assertProductImageChange({ imageBase64: 'old invalid' }, { imageBase64: 'old invalid', englishName: 'Updated' })).not.toThrow();
    expect(() => assertProductImageChange({}, { imageBase64: pixel, imageExtension: 'jpeg' })).toThrow('扩展名');
  });
});
