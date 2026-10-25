import { AsyncLocalStorage } from 'node:async_hooks';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db/client.js';
import { LingxingReadError, type LingxingReadCoordinator, type LingxingTokens } from './read-client.js';

export function encryptLingxingTokens(tokens: LingxingTokens, secret: string) {
  const iv = randomBytes(12);
  const key = createHash('sha256').update(`scm-lingxing-tokens-v1:${secret}`).digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64')).join('.');
}
export function decryptLingxingTokens(value: string, secret: string): LingxingTokens {
  const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64'));
  if (!iv || !tag || !encrypted) throw new Error('INVALID_ENCRYPTED_TOKENS');
  const key = createHash('sha256').update(`scm-lingxing-tokens-v1:${secret}`).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
  const result: unknown = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
  if (!result || typeof result !== 'object' || !('accessToken' in result) || typeof result.accessToken !== 'string' || !result.accessToken) throw new Error('INVALID_ENCRYPTED_TOKENS');
  return result as LingxingTokens;
}

export async function createLingxingCoordinator(appId: string, secret: string): Promise<LingxingReadCoordinator> {
  const key = createHash('sha256').update(appId).digest('hex');
  const scope = new AsyncLocalStorage<PoolClient>();
  const query = (text: string, values: unknown[]) => (scope.getStore() ?? pool).query(text, values);
  return {
    async exclusive<T>(operation: string, work: () => Promise<T>) {
      const existing = scope.getStore(); const connection = existing ?? await pool.connect();
      const lockKey = `lingxing:${key}:${operation}`;
      let locked = false;
      try {
        // Keep a session lock over the remote request, without an open SQL
        // transaction. The operating system releases it when a worker dies.
        for (let attempt = 0; attempt < 300; attempt++) {
          const result = await connection.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1, 0)) as locked', [lockKey]);
          if (result.rows[0]?.locked) { locked = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!locked) throw new LingxingReadError('LINGXING_RATE_LIMITED', '领星查询协调繁忙，请稍后重试。');
        return await scope.run(connection, work);
      } finally {
        let failedUnlock = false;
        try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]); }
        catch { failedUnlock = true; }
        finally { if (!existing) connection.release(failedUnlock); }
      }
    },
    async loadTokens() {
      const result = await query('select ciphertext from lingxing_token_cache where key = $1', [key]);
      if (!result.rows[0]) return null;
      try { return decryptLingxingTokens(String(result.rows[0].ciphertext), secret); }
      catch { return null; } // A rotated server key causes a fresh authentication.
    },
    async saveTokens(tokens) {
      await query('insert into lingxing_token_cache (key, ciphertext, updated_at) values ($1,$2,now()) on conflict (key) do update set ciphertext = excluded.ciphertext, updated_at = now()', [key, encryptLingxingTokens(tokens, secret)]);
    },
    async readyAt(operation) {
      const result = await query('select available_at from lingxing_read_cooldown where key = $1', [`${key}:${operation}`]);
      return result.rows[0] ? new Date(result.rows[0].available_at as string).getTime() : 0;
    },
    async cooldown(operation, until) {
      await query('insert into lingxing_read_cooldown (key,available_at) values ($1,$2) on conflict (key) do update set available_at = greatest(lingxing_read_cooldown.available_at, excluded.available_at)', [`${key}:${operation}`, new Date(until)]);
    },
  };
}
