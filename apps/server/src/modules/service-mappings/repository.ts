import { asc, isNull } from 'drizzle-orm';
import type { ServiceMapping } from '@scm/contracts';
import type { BatchTx } from '../batches/service.js';
import { serviceMappings } from './schema.js';

export type ActiveServiceMapping = Pick<ServiceMapping, 'id' | 'version' | 'countryCode' | 'transportMethod' | 'service'>;
export async function getActiveServiceMappingsInTx(tx: BatchTx): Promise<ActiveServiceMapping[]> {
  return tx.select({ id: serviceMappings.id, version: serviceMappings.version, countryCode: serviceMappings.countryCode,
    transportMethod: serviceMappings.transportMethod, service: serviceMappings.service }).from(serviceMappings)
    .where(isNull(serviceMappings.deletedAt)).orderBy(asc(serviceMappings.countryCode), asc(serviceMappings.transportMethod));
}
