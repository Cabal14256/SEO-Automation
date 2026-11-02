import { beforeEach, describe, expect, it, vi } from 'vitest';
import { documentFieldOptionsSchema } from '@scm/contracts';

const mocks = vi.hoisted(() => ({ requireActor: vi.fn(), mappings: vi.fn(), transaction: {} }));
vi.mock('../batches/service.js', () => ({ requireBatchActor: mocks.requireActor }));
vi.mock('../../db/client.js', () => ({ db: { transaction: async (action: (tx: unknown) => unknown) => action(mocks.transaction) } }));
vi.mock('../service-mappings/repository.js', () => ({ getActiveServiceMappingsInTx: mocks.mappings }));
import { getDocumentFieldOptions } from './field-options.js';

beforeEach(() => {
  vi.clearAllMocks(); mocks.requireActor.mockResolvedValue({}); mocks.mappings.mockResolvedValue([]);
});

describe('manually maintained invoice service choices', () => {
  it('returns unique nonempty service values from active country and transport mappings', async () => {
    mocks.mappings.mockResolvedValue([{ countryCode: 'US', transportMethod: '海派', service: ' 丰速达18T卡派 ' },
      { countryCode: 'GB', transportMethod: '卡航', service: '中欧卡航VAT-递延' },
      { countryCode: 'FR', transportMethod: '卡航', service: '中欧卡航VAT-递延' }, { service: ' ' }]);
    const result = await getDocumentFieldOptions('admin');
    expect(documentFieldOptionsSchema.parse(result)).toEqual({ services: ['丰速达18T卡派', '中欧卡航VAT-递延'] });
    expect(mocks.requireActor).toHaveBeenCalledWith(mocks.transaction, 'admin');
    expect(mocks.mappings).toHaveBeenCalledWith(mocks.transaction);
    expect(result).not.toHaveProperty('lingxing');
  });

  it('leaves the service list empty when no mappings have been maintained', async () => {
    expect(await getDocumentFieldOptions('admin')).toEqual({ services: [] });
  });

  it('rejects inactive actors before reading any mappings', async () => {
    mocks.requireActor.mockRejectedValueOnce(new Error('inactive actor'));
    await expect(getDocumentFieldOptions('old-admin')).rejects.toThrow('inactive actor');
    expect(mocks.mappings).not.toHaveBeenCalled();
  });

  it('reports storage failures instead of replacing service names with remote channel codes', async () => {
    mocks.mappings.mockRejectedValueOnce(new Error('mapping storage unavailable'));
    await expect(getDocumentFieldOptions('admin')).rejects.toThrow('mapping storage unavailable');
  });
});
