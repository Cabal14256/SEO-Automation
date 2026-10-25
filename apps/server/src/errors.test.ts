import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorCode, isDatabaseUnavailable, logError } from './errors.js';

afterEach(() => vi.restoreAllMocks());

describe('private runtime diagnostics', () => {
  it('omits SQL, connection strings, passwords and nested private values from logs', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = Object.assign(new Error('postgresql://local:private-password@localhost/db'), {
      query: 'private query', params: ['private-password'],
      cause: Object.assign(new Error('private account'), { code: 'ECONNREFUSED' }),
    });
    logError('Database failed', failure);
    expect(output.mock.calls).toEqual([['Database failed', { code: 'ECONNREFUSED' }]]);
  });

  it('recognizes wrapped database connection failures without exposing arbitrary error codes', () => {
    expect(isDatabaseUnavailable({ cause: { code: '57P01' } })).toBe(true);
    expect(isDatabaseUnavailable({ cause: { code: '08006' } })).toBe(true);
    expect(isDatabaseUnavailable({ code: '23505' })).toBe(false);
    expect(errorCode({ code: 'postgresql://private-secret' })).toBeNull();
  });
});
