import { readConfig } from './config.js';
import { db } from './db/client.js';
import { fileIndex } from './db/schema.js';
import { storeImmutableFile, type StoreFileInput } from './file-store.js';

export async function saveBusinessFile(input: StoreFileInput) {
  const { dataDir } = readConfig();
  return storeImmutableFile(dataDir, input, async (record) => {
    await db.insert(fileIndex).values(record);
  });
}
