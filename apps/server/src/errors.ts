const connectionCodes = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'ETIMEDOUT', 'EPIPE', '57P01', '57P02', '57P03',
]);

export function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const record = error as { code?: unknown; cause?: unknown };
  if (typeof record.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(record.code)) return record.code;
  return record.cause === error ? null : errorCode(record.cause);
}

export function isDatabaseUnavailable(error: unknown): boolean {
  const code = errorCode(error);
  return code !== null && (connectionCodes.has(code) || code.startsWith('08'));
}

// Database and authentication errors can contain connection strings, query parameters,
// account data and secrets. Only the fixed event and a validated error code leave the process.
export function logError(event: string, error: unknown): void {
  console.error(event, { code: errorCode(error) ?? 'UNKNOWN' });
}
