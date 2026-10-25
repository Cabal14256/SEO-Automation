import 'dotenv/config';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.url().refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://'), '必须是 PostgreSQL URL'),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET 至少 32 个字符'),
  BETTER_AUTH_URL: z.url().default('http://localhost:3001'),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATA_DIR: z.string().min(1),
  WEB_DIST_DIR: z.string().optional(),
  LINGXING_REQUESTS_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  LINGXING_APP_ID: z.string().optional(),
  LINGXING_APP_SECRET: z.string().optional(),
  LINGXING_ACCESS_TOKEN: z.string().optional(),
  LINGXING_ENV_FILE: z.string().optional(),
  LINGXING_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(30000),
});

export type AppConfig = z.infer<typeof envSchema> & {
  dataDir: string;
  webDistDir: string;
};

function within(root: string, path: string): boolean {
  const part = relative(resolve(root), resolve(path));
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

function physicalPath(path: string): string {
  let cursor = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try { lstatSync(cursor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor)); cursor = parent; continue;
    }
    return resolve(realpathSync.native(cursor), ...missing);
  }
}

// Kept in the server build so an immutable release does not import source scripts.
export function resolveDataDirectory(projectRoot: string, input: string): string {
  if (!isAbsolute(input) || input.split(/[\\/]/).includes('..')) throw new Error('DATA_DIR 必须是无上级跳转的绝对路径');
  const dataDir = resolve(input); const source = resolve(projectRoot);
  const physicalSource = physicalPath(source); const physicalData = physicalPath(dataDir);
  if (dataDir === dirname(dataDir) || physicalData === dirname(physicalData)) throw new Error('DATA_DIR 不能是磁盘根目录');
  if (within(source, dataDir)) {
    if (!within(resolve(source, '.local/development/data'), dataDir)
      || !within(resolve(physicalSource, '.local/development/data'), physicalData)) throw new Error('项目内 DATA_DIR 必须位于 .local/development/data');
  } else if (within(dataDir, source) || within(physicalSource, physicalData) || within(physicalData, physicalSource)) {
    throw new Error('DATA_DIR 不能与项目源码目录重叠');
  }
  return dataDir;
}

export function readConfig(input: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw = envSchema.parse(input);
  const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const dataDir = resolveDataDirectory(projectRoot, raw.DATA_DIR);

  return {
    ...raw,
    dataDir,
    webDistDir: raw.WEB_DIST_DIR
      ? resolve(raw.WEB_DIST_DIR)
      : resolve(process.cwd(), '../web/dist'),
  };
}
