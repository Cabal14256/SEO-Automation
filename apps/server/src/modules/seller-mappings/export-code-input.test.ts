import { describe, expect, it } from 'vitest';
import { sellerExportCodeInputSchema } from '@scm/contracts';

const metadata = { operationId: '10000000-0000-4000-8000-000000000001', expectedVersion: 7 };

describe('seller export code text input', () => {
  it.each(['001', '00Ab_沪-@＋(一)', '=00AB+1', '-001', '001.25', '00A/B\\C:*?"<>|', 'A B'])('preserves %s as text together with operation and version metadata', (code) => {
    const input = { ...metadata, code }, before = structuredClone(input);
    expect(sellerExportCodeInputSchema.parse(input)).toEqual(input);
    expect(input).toEqual(before);
  });
  it('trims outer spaces and permits clearing the configured code', () => {
    expect(sellerExportCodeInputSchema.parse({ ...metadata, code: '  00Ab-沪  ' })).toEqual({ ...metadata, code: '00Ab-沪' });
    expect(sellerExportCodeInputSchema.parse({ ...metadata, expectedVersion: 0, code: '   ' })).toEqual({ ...metadata, expectedVersion: 0, code: '' });
  });
  it.each(['A'.repeat(20), '中'.repeat(20)])('accepts the full 20-character limit', (code) => {
    expect(sellerExportCodeInputSchema.parse({ ...metadata, code }).code).toBe(code);
    expect(sellerExportCodeInputSchema.safeParse({ ...metadata, code: code + '1' }).success).toBe(false);
  });
  it.each(['00A\nB', '00A\rB', '00A\tB', '00A\u0000B', '00A\u007fB', '00A\u0085B'])('rejects a code containing a control character', (code) => {
    expect(sellerExportCodeInputSchema.safeParse({ ...metadata, code }).success).toBe(false);
  });
  it('keeps operation identity and optimistic version checks mandatory', () => {
    for (const invalid of [
      { ...metadata, operationId: 'invalid', code: 'A01' },
      { ...metadata, expectedVersion: -1, code: 'A01' },
      { ...metadata, expectedVersion: 1.5, code: 'A01' },
      { ...metadata, code: 1 },
      { ...metadata, code: 'A01', sid: 1 },
    ]) expect(sellerExportCodeInputSchema.safeParse(invalid).success).toBe(false);
  });
});
