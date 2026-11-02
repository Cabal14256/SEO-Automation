import type { DocumentFieldOptions } from '@scm/contracts';
import { db } from '../../db/client.js';
import { requireBatchActor } from '../batches/service.js';
import { getActiveServiceMappingsInTx } from '../service-mappings/repository.js';

/** Service values are maintained by people; Lingxing supplies the mapping keys only. */
export async function getDocumentFieldOptions(actorId: string): Promise<DocumentFieldOptions> {
  return db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    const mappings = await getActiveServiceMappingsInTx(tx);
    return { services: [...new Set(mappings.map((mapping) => mapping.service.trim()).filter(Boolean))] };
  });
}
