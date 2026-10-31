import { describe, expect, it, vi } from 'vitest';
import type { BatchTx } from '../batches/service.js';
vi.mock('../imports/service.js', () => ({ checkedFileBytes: vi.fn() }));
import { checkedFileBytes } from '../imports/service.js';
import { DocumentReadContext } from './read-context.js';

describe('request-scoped document read context', () => {
  it('coalesces concurrent reads, isolates namespaces and never caches across requests', async () => {
    const tx = {} as BatchTx, context = new DocumentReadContext(tx), load = vi.fn(async () => ({ version: 1 }));
    const values = await Promise.all([context.memo('group', ['id', 1], load), context.memo('group', ['id', 1], load)]);
    expect(values[0]).toBe(values[1]); expect(load).toHaveBeenCalledTimes(1);
    await context.memo('group', ['id', 2], load);
    await context.memo('profile', ['id', 1], load);
    await new DocumentReadContext(tx).memo('group', ['id', 1], load);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('checks each archive identity/hash once and does not reuse failures or bytes across requests', async () => {
    const checked = vi.mocked(checkedFileBytes); checked.mockReset(); checked.mockResolvedValue(Buffer.from('archive'));
    const file = { id: 'file-id', storageKey: 'archive.bin', sha256: 'a'.repeat(64), byteSize: 7 };
    const tx = {} as BatchTx, context = new DocumentReadContext(tx);
    await Promise.all([context.fileBytes(file), context.fileBytes(file)]);
    expect(checked).toHaveBeenCalledTimes(1);
    await context.fileBytes({ ...file, sha256: 'b'.repeat(64) });
    await new DocumentReadContext(tx).fileBytes(file);
    expect(checked).toHaveBeenCalledTimes(3);
    checked.mockRejectedValue(new Error('hash mismatch'));
    const broken = { ...file, id: 'broken' };
    await expect(context.fileBytes(broken)).rejects.toThrow('hash mismatch');
    await expect(context.fileBytes(broken)).rejects.toThrow('hash mismatch');
    expect(checked).toHaveBeenCalledTimes(4);
    await expect(new DocumentReadContext(tx).fileBytes(broken)).rejects.toThrow('hash mismatch');
    expect(checked).toHaveBeenCalledTimes(5);
  });
});
