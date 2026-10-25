import { fromBuffer, type Entry, type ZipFile } from 'yauzl';

export class ArchiveValidationError extends Error {
  constructor(public code: string) { super('工作簿压缩结构无效或超过解析限制，请核对原文件。'); }
}
// Validate declared AND actual expanded bytes before the synchronous OOXML
// parser receives the archive. Nothing is written to disk or fetched remotely.
export async function validateImportArchive(bytes: Buffer): Promise<void> {
  const archive = await new Promise<ZipFile>((done, reject) => fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, file) => error || !file ? reject(new ArchiveValidationError('INVALID_XLSX')) : done(file)));
  await new Promise<void>((done, reject) => {
    let settled = false;
    let count = 0;
    let actualTotal = 0;
    let declaredTotal = 0;
    const names = new Set<string>();
    const finish = (code?: string) => {
      if (settled) return;
      settled = true; archive.close();
      if (code) reject(new ArchiveValidationError(code)); else done();
    };
    archive.on('error', () => finish('INVALID_XLSX'));
    archive.on('end', () => finish());
    archive.on('entry', (entry: Entry) => {
      const name = entry.fileName;
      if (++count > 1000 || declaredTotal + entry.uncompressedSize > 64 * 1024 * 1024 || entry.uncompressedSize > 32 * 1024 * 1024) return finish('ARCHIVE_LIMIT_EXCEEDED');
      declaredTotal += entry.uncompressedSize;
      if (!name || names.has(name) || /[\\:]/.test(name) || name.includes('\0') || name.startsWith('/') || name.split('/').some((part) => part === '.' || part === '..')) return finish('UNSAFE_ARCHIVE_PATH');
      names.add(name);
      if (entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)) return finish('UNSUPPORTED_WORKBOOK');
      if (/vbaProject\.bin$|^xl\/externalLinks\//i.test(name)) return finish('UNSUPPORTED_WORKBOOK');
      if (name.endsWith('/')) { archive.readEntry(); return; }
      archive.openReadStream(entry, (error, stream) => {
        if (error || !stream) return finish('INVALID_XLSX');
        let entryBytes = 0;
        let tail = '';
        let relationship = '';
        stream.on('error', () => finish('INVALID_XLSX'));
        stream.on('data', (chunk: Buffer) => {
          entryBytes += chunk.length; actualTotal += chunk.length;
          if (entryBytes > 32 * 1024 * 1024 || actualTotal > 64 * 1024 * 1024) { stream.destroy(); finish('ARCHIVE_LIMIT_EXCEEDED'); return; }
          if (/\.xml$|\.rels$/i.test(name)) {
            const part = tail + chunk.toString('utf8');
            if (/<!DOCTYPE|<!ENTITY/i.test(part)) { stream.destroy(); finish('XML_DTD_NOT_SUPPORTED'); return; }
            tail = part.slice(-32);
          }
          if (/\.rels$/i.test(name)) relationship += chunk.toString('utf8');
        });
        stream.on('end', () => {
          if (settled) return;
          if (entryBytes !== entry.uncompressedSize) return finish('INVALID_XLSX');
          // Harmless hyperlinks are never fetched. External workbook links are
          // unsupported; these can otherwise change cached business values.
          if (/\.rels$/i.test(name)) for (const match of relationship.matchAll(/<Relationship\b[^>]*>/gi)) {
            if (/TargetMode\s*=\s*["']External["']/i.test(match[0]) && !/Type\s*=\s*["'][^"']*\/hyperlink["']/i.test(match[0])) return finish('EXTERNAL_WORKBOOK_LINK');
          }
          archive.readEntry();
        });
      });
    });
    archive.readEntry();
  });
}
