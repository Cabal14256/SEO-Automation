/** The same filename normalization is used by export generation and settings previews. */
export function invoiceFilenamePart(value: string | null | undefined, fallback: string): string {
  const text = (value ?? '').trim().replace(/[\\/:*?"<>|\p{Cc}]/gu, '_').replace(/\s+/g, ' ').replace(/[. ]+$/g, '');
  return (text || fallback).slice(0, 40).replace(/[\uD800-\uDBFF]$/u, '').replace(/[. ]+$/g, '');
}
