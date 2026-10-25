import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeSeller, syncSellerCatalog, validateLingxingSellers } from './catalog.js';

afterEach(() => vi.unstubAllEnvs());

type Seller = Parameters<typeof activeSeller>[0];
const manual: Seller = { id: randomUUID(), sid: 910003, name: '人工显示名称', country: '人工国家', marketplaceId: 'manual-marketplace', wid: null,
  status: 'candidate', version: 3, sourceObservedAt: new Date('2026-10-16T01:00:00Z'), sourceSha256: '1'.repeat(64), sourceFileId: null,
  updatedAt: new Date('2026-10-17T01:00:00Z'), manualEnabled: true, lingxingAutoApproved: true, lingxingDisabled: false,
  lingxingData: { name: '实际领星名称', country: '美国', marketplaceId: 'actual-marketplace', status: '1', present: true,
    observedAt: '2026-10-17T02:00:00.000Z', sha256: '2'.repeat(64), fileId: randomUUID() } };

describe('seller catalog source selection', () => {
  it('refuses catalog sync in an offline environment before querying even an injected source', async () => {
    vi.stubEnv('LINGXING_REQUESTS_ENABLED', 'false');
    const querySellers = vi.fn();
    await expect(syncSellerCatalog({ operationId: randomUUID(), expectedVersion: 1 }, 'offline-actor', { querySellers }))
      .rejects.toMatchObject({ code: 'LINGXING_REQUESTS_DISABLED', status: 503 });
    expect(querySellers).not.toHaveBeenCalled();
  });

  it('selects independent actual versus manual fields without changing canonical sid or stored values', () => {
    const original = structuredClone(manual);
    const actual = activeSeller(manual, 'lingxing')!;
    expect(actual).toMatchObject({ id: manual.id, sid: manual.sid, name: '实际领星名称', country: '美国', marketplaceId: 'actual-marketplace', version: 3 });
    expect(actual.sourceObservedAt.toISOString()).toBe(manual.lingxingData!.observedAt);
    expect(actual.sourceSha256).toBe('2'.repeat(64));
    expect(actual.sourceFileId).toBe(manual.lingxingData!.fileId);
    expect(activeSeller(manual, 'manual')).toMatchObject({ name: '人工显示名称', country: '人工国家', marketplaceId: 'manual-marketplace', sourceSha256: '1'.repeat(64) });
    expect(manual).toEqual(original);
  });

  it('does not silently substitute manual data when an actual seller is absent', () => {
    expect(activeSeller({ ...manual, lingxingData: null }, 'lingxing')).toBeNull();
    expect(activeSeller({ ...manual, lingxingData: { ...manual.lingxingData!, present: false } }, 'lingxing')).toBeNull();
    expect(activeSeller({ ...manual, manualEnabled: false }, 'manual')).toBeNull();
    expect(activeSeller({ ...manual, manualEnabled: false }, 'lingxing')?.name).toBe('实际领星名称');
  });

  it('keeps local disable effective and blocks remote authorization status other than 1', () => {
    expect(activeSeller({ ...manual, lingxingDisabled: true }, 'lingxing')?.status).toBe('disabled');
    expect(activeSeller({ ...manual, lingxingData: { ...manual.lingxingData!, status: '0' } }, 'lingxing')?.status).toBe('disabled');
    expect(activeSeller({ ...manual, lingxingData: { ...manual.lingxingData!, status: '0' } }, 'manual')?.status).toBe('candidate');
  });

  it('automatically approves the trusted remote view while leaving the manual candidate profile untouched', () => {
    expect(activeSeller(manual, 'lingxing')?.status).toBe('approved');
    expect(activeSeller(manual, 'manual')?.status).toBe('candidate');
    expect(activeSeller({ ...manual, lingxingAutoApproved: false }, 'lingxing')?.status).toBe('disabled');
    expect(activeSeller({ ...manual, status: 'disabled' }, 'manual')?.status).toBe('disabled');
    expect(activeSeller({ ...manual, status: 'disabled' }, 'lingxing')?.status).toBe('approved');
  });

  it.each(['', 'not-a-time'])('blocks malformed cached identities even when an auto-approval flag exists: %s', (observedAt) => {
    expect(activeSeller({ ...manual, lingxingData: { ...manual.lingxingData!, observedAt } }, 'lingxing')?.status).toBe('disabled');
    expect(activeSeller({ ...manual, lingxingData: { ...manual.lingxingData!, name: ' ' } }, 'lingxing')?.status).toBe('disabled');
    expect(activeSeller({ ...manual, lingxingData: { ...manual.lingxingData!, country: '' } }, 'lingxing')?.status).toBe('disabled');
  });

  it('accepts only successful, complete-looking unique seller identities with original authorization status', () => {
    const seller = { sid: 910003, name: '实际店铺', country: '美国', marketplace_id: 'ATVPDKIKX0DER', status: 1 };
    expect(validateLingxingSellers({ code: 0, data: [seller] })[0]).toMatchObject({ sid: 910003, status: '1' });
    expect(() => validateLingxingSellers({ code: 403, data: [seller] })).toThrow();
    expect(() => validateLingxingSellers({ code: 0, data: [seller, seller] })).toThrow();
    expect(() => validateLingxingSellers({ code: 0, data: [] })).toThrow();
    expect(() => validateLingxingSellers({ code: 0, data: [{ ...seller, sid: -1 }] })).toThrow();
    expect(() => validateLingxingSellers({ code: 0, data: [{ ...seller, sid: 2147483648 }] })).toThrow();
    expect(() => validateLingxingSellers({ code: 0, data: [{ ...seller, country: '' }] })).toThrow();
    expect(() => validateLingxingSellers({ code: 0, data: [{ sid: 910003, name: '店铺', country: '美国' }] })).toThrow();
  });
});
