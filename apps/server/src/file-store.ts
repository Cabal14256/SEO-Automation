import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export type NewFileIndex = {
  id: string;
  storageKey: string;
  sha256: string;
  byteSize: number;
  originalName: string;
  mimeType: string;
  createdBy: string | null;
};

export type StoreFileInput = {
  bytes: Buffer;
  originalName: string;
  mimeType: string;
  createdBy: string | null;
};

export async function storeImmutableFile(
  dataDir: string,
  input: StoreFileInput,
  indexFile: (record: NewFileIndex) => Promise<void>,
): Promise<NewFileIndex> {
  if (input.bytes.length === 0) throw new Error('不能保存空文件');
  const id = randomUUID();
  const storageKey = join('files', id.slice(0, 2), id).replaceAll('\\', '/');
  const target = join(dataDir, storageKey);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const record: NewFileIndex = {
    id,
    storageKey,
    sha256: createHash('sha256').update(input.bytes).digest('hex'),
    byteSize: input.bytes.length,
    originalName: basename(input.originalName),
    mimeType: input.mimeType,
    createdBy: input.createdBy,
  };

  await mkdir(join(dataDir, 'files', id.slice(0, 2)), { recursive: true });
  try {
    await writeFile(temporary, input.bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
    try {
      await indexFile(record);
    } catch (error) {
      try {
        await unlink(target);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], '文件索引失败，且清理已写文件失败');
      }
      throw error;
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }

  return record;
}
