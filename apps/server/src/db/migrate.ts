import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDatabase, db } from './client.js';

try {
  await migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  process.stdout.write('数据库迁移完成。\n');
} finally {
  await closeDatabase();
}
