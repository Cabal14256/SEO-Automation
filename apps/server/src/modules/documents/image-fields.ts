import { documentFieldsSchema, documentProductImageInfo } from '@scm/contracts';
import { BatchError } from '../batches/service.js';

export function assertProductImageChange(previous: Readonly<Record<string, unknown>>, next: Readonly<Record<string, unknown>>) {
  if (previous.imageBase64 === next.imageBase64 && previous.imageExtension === next.imageExtension || next.imageBase64 === null || next.imageBase64 === undefined || typeof next.imageBase64 === 'string' && !next.imageBase64.trim()) return;
  const image = typeof next.imageBase64 === 'string' ? documentProductImageInfo(next.imageBase64) : null;
  if (!image || next.imageExtension && next.imageExtension !== image.extension) throw new BatchError('DOCUMENT_IMAGE_INVALID', 422, '新增或替换的图片须为不超过2 MiB的完整PNG/JPEG，扩展名须与实际内容一致。');
}

/** Legacy image contents are not rewritten or rejected on an unrelated edit. */
export function assertDocumentImageChanges(previous: Readonly<Record<string, string | null>>, next: Readonly<Record<string, string | null>>) {
  documentFieldsSchema.parse(next);
  for (const key of Object.keys(next)) {
    if (!/^product\.[a-f0-9]{64}\.imageBase64$/.test(key)) continue;
    const extensionKey = key.replace(/imageBase64$/, 'imageExtension');
    assertProductImageChange({ imageBase64: previous[key], imageExtension: previous[extensionKey] }, { imageBase64: next[key], imageExtension: next[extensionKey] });
  }
}
