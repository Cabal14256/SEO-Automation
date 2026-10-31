import type { BatchTx } from '../batches/service.js';
import { checkedFileBytes } from '../imports/service.js';

/** A read projection owns this cache. Never keep it in module/global state or reuse it for writes. */
export class DocumentReadContext {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(readonly tx: BatchTx) {}

  memo<T>(namespace: string, identity: unknown, load: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([namespace, identity]);
    let value = this.pending.get(key);
    if (!value) {
      value = Promise.resolve().then(load);
      this.pending.set(key, value);
    }
    return value as Promise<T>;
  }

  fileBytes(file: { id?: string; storageKey: string; sha256: string; byteSize: number }) {
    return this.memo('archive', [file.id, file.storageKey, file.sha256, file.byteSize], () => checkedFileBytes(file));
  }
}
