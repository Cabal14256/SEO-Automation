import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { readConfig } from '../config.js';
import { logError } from '../errors.js';
import * as schema from './schema.js';

const config = readConfig();

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5_000,
  query_timeout: 15_000,
  options: '-c timezone=Asia/Shanghai',
});

pool.on('error', (error) => logError('Database connection failed', error));

export const db = drizzle({ client: pool, schema });

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
