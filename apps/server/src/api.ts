import { mkdir } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { PgBoss } from 'pg-boss';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { closeDatabase } from './db/client.js';
import { logError } from './errors.js';
import { DEMO_QUEUE } from './tasks.js';
import { IMPORT_QUEUE } from './modules/imports/service.js';
import { EXPORT_QUEUE } from './modules/batches/report-service.js';
import { BATCH_SYNC_QUEUE } from './modules/batches/sync-jobs.js';
import { FBA_LOOKUP_QUEUE } from './modules/imports/fba-lookup.js';
import { PHYSICAL_SYNC_QUEUE } from './modules/physical/sync.js';
import { PHYSICAL_EXPORT_QUEUE } from './modules/physical/exports.js';
import { WORKFLOW_EXPORT_QUEUE } from './modules/workflow/exports.js';
import { DOCUMENT_AUTOMATION_QUEUE } from './modules/documents/automation.js';
import { DOCUMENT_EXPORT_QUEUE } from './modules/documents/exports.js';

const config = readConfig();
await mkdir(config.dataDir, { recursive: true });

let boss: PgBoss | null = null;
let stopping = false;
const app = createApp(() => boss);
const server = serve({ fetch: app.fetch, hostname: config.HOST, port: config.PORT });
console.log(`API listening on ${config.HOST}:${config.PORT}`);

async function startQueue(): Promise<void> {
  while (!stopping) {
    const candidate = new PgBoss({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 5_000,
      options: '-c timezone=Asia/Shanghai' });
    candidate.on('error', (error) => logError('Persistent queue connection failed', error));
    try {
      await candidate.start();
      await candidate.createQueue(DEMO_QUEUE, { retryLimit: 0, deleteAfterSeconds: 0 });
      await candidate.createQueue(DOCUMENT_AUTOMATION_QUEUE, { retryLimit: 0, expireInSeconds: 7200, deleteAfterSeconds: 0 });
      await candidate.createQueue(DOCUMENT_EXPORT_QUEUE, { retryLimit: 2, retryDelay: 5, expireInSeconds: 180, deleteAfterSeconds: 0 });
      await candidate.createQueue(WORKFLOW_EXPORT_QUEUE, { retryLimit: 2, retryDelay: 5, expireInSeconds: 300, deleteAfterSeconds: 0 });
      await candidate.createQueue(IMPORT_QUEUE, { retryLimit: 0, expireInSeconds: 120, deleteAfterSeconds: 0 });
      await candidate.createQueue(EXPORT_QUEUE, { retryLimit: 2, retryDelay: 5, expireInSeconds: 180, deleteAfterSeconds: 0 });
      await candidate.createQueue(BATCH_SYNC_QUEUE, { retryLimit: 0, expireInSeconds: 7200, deleteAfterSeconds: 0 });
      await candidate.createQueue(FBA_LOOKUP_QUEUE, { retryLimit: 0, expireInSeconds: 1200, deleteAfterSeconds: 0 });
      await candidate.createQueue(PHYSICAL_SYNC_QUEUE, { retryLimit: 0, expireInSeconds: 7200, deleteAfterSeconds: 0 });
      await candidate.createQueue(PHYSICAL_EXPORT_QUEUE, { retryLimit: 2, retryDelay: 5, expireInSeconds: 180, deleteAfterSeconds: 0 });
      if (stopping) {
        await candidate.stop();
        return;
      }
      boss = candidate;
      console.log('Persistent task queue ready');
      return;
    } catch (error) {
      logError('Persistent queue unavailable; retrying in 5 seconds', error);
      await candidate.stop().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

void startQueue();

async function shutdown() {
  stopping = true;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await boss?.stop();
  await closeDatabase();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
