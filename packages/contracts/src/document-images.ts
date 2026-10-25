export const DOCUMENT_PRODUCT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const DOCUMENT_PRODUCT_IMAGES_MAX_BYTES = 8 * 1024 * 1024;
export const DOCUMENT_IMAGE_FIELDS_JSON_MAX_BYTES = 12 * 1024 * 1024;
export type DocumentProductImageInfo = { base64: string; extension: 'png' | 'jpeg'; byteLength: number; width: number; height: number };

/** Portable structural validation shared by upload, snapshot and XLSX paths. */
export function documentProductImageInfo(value: string | null | undefined): DocumentProductImageInfo | null {
  if (!value?.trim()) return null;
  const input = value.trim(), prefix = /^data:image\/(png|jpeg);base64,/.exec(input);
  const base64 = prefix ? input.slice(prefix[0].length) : input;
  if (!base64.length || base64.length > Math.ceil(DOCUMENT_PRODUCT_IMAGE_MAX_BYTES / 3) * 4 || base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  let binary: string;
  try { binary = atob(base64); if (btoa(binary) !== base64) return null; } catch { return null; }
  if (!binary.length || binary.length > DOCUMENT_PRODUCT_IMAGE_MAX_BYTES) return null;
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0)), view = new DataView(bytes.buffer);
  const result = (extension: 'png' | 'jpeg', width: number, height: number): DocumentProductImageInfo | null => width > 0 && height > 0 && (!prefix || prefix[1] === extension) ? { base64, extension, byteLength: bytes.length, width, height } : null;
  if (bytes.length >= 45 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) {
    let offset = 8, width = 0, height = 0, hasData = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset), end = offset + 12 + length;
      if (end > bytes.length) return null;
      const kind = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (offset === 8) {
        if (kind !== 'IHDR' || length !== 13) return null;
        width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
        const depth = bytes[offset + 16]!, color = bytes[offset + 17]!;
        const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
        if (width > 0x7fffffff || height > 0x7fffffff || !depths[color]?.includes(depth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || ![0, 1].includes(bytes[offset + 20]!)) return null;
      } else if (kind === 'IHDR') return null;
      if (kind === 'IDAT' && length > 0) hasData = true;
      if (kind === 'IEND') return length === 0 && end === bytes.length && hasData ? result('png', width, height) : null;
      offset = end;
    }
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) {
    let offset = 2, width = 0, height = 0;
    const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset < bytes.length - 2) {
      if (bytes[offset++] !== 255) return null;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0 || marker === 0xd8 || marker === 0xd9) return null;
      if (marker === 1 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > bytes.length - 2) return null;
      const length = view.getUint16(offset), end = offset + length;
      if (length < 2 || end > bytes.length - 2) return null;
      if (frames.has(marker)) {
        if (length < 11 || length !== 8 + 3 * bytes[offset + 7]!) return null;
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5);
      }
      if (marker === 0xda) return length >= 6 && end < bytes.length - 2 ? result('jpeg', width, height) : null;
      offset = end;
    }
  }
  return null;
}
