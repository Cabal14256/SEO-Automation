import { documentCountryCode } from '@scm/contracts';

const regions = new Intl.DisplayNames(['zh-CN'], { type: 'region' });

/** Keep mapping countries consistent with the synced Lingxing country directory. */
export function normalizeServiceMappingCountry(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFKC').trim().toUpperCase();
  return documentCountryCode(normalized) ?? (/^[A-Z]{2}$/.test(normalized) && normalized !== 'ZZ' && regions.of(normalized) !== normalized ? normalized : undefined);
}
