import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { storeImmutableFile } from './file-store.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('immutable file store', () => {
  it('writes bytes before indexing and records the exact SHA-256', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scm-file-test-'));
    dirs.push(dir);
    const bytes = Buffer.from('invoice version 1');
    const record = await storeImmutableFile(dir, {
      bytes,
      originalName: 'invoice.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      createdBy: null,
    }, async (index) => {
      expect(await readFile(join(dir, index.storageKey))).toEqual(bytes);
    });

    expect(record.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await readFile(join(dir, record.storageKey))).toEqual(bytes);
  });

  it('removes a published file when its index insert fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scm-file-test-'));
    dirs.push(dir);
    let savedKey = '';

    await expect(storeImmutableFile(dir, {
      bytes: Buffer.from('unindexed'),
      originalName: 'bill.xlsx',
      mimeType: 'application/octet-stream',
      createdBy: null,
    }, async (record) => {
      savedKey = record.storageKey;
      throw new Error('database unavailable');
    })).rejects.toThrow('database unavailable');

    const folder = join(dir, savedKey.split('/').slice(0, -1).join('/'));
    expect(await readdir(folder)).toEqual([]);
  });
});
