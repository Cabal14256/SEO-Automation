import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertRuntimePath } from '../shared/path-policy.mjs';

// Technical development accounts only. Generated passwords never go to stdout.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const serverRoot = resolve(projectRoot, 'apps/server');
const requireServer = createRequire(resolve(serverRoot, 'package.json'));
const { parse } = requireServer('dotenv');
Object.assign(process.env, parse(await readFile(resolve(serverRoot, '.env'))));
process.env.TZ = 'Asia/Shanghai';
assert.equal(new URL(process.env.DATABASE_URL).pathname, '/scm_automation_dev', 'Use the dedicated development database');
const output = assertRuntimePath(projectRoot, process.env.M0_CREDENTIALS_FILE || resolve(projectRoot, '.local/development/accounts.json'), 'development');
const { auth } = await import(pathToFileURL(resolve(serverRoot, 'dist/auth.js')));
const { closeDatabase } = await import(pathToFileURL(resolve(serverRoot, 'dist/db/client.js')));
const accounts = {};
try {
  // Reserve the destination first so a retry cannot silently replace credentials.
  await writeFile(output, '{}\n', { flag: 'wx', mode: 0o600 });
  for (const role of ['admin']) {
    const email = `scm-dev-${role}@local.test`;
    const password = randomBytes(32).toString('base64url');
    const created = await auth.api.createUser({ body: { email, password, name: `M0 开发 ${role}`, role } });
    accounts[role] = { id: created.user.id, email, password };
    // Preserve each successfully created account even if a later account fails.
    await writeFile(output, JSON.stringify(accounts, null, 2) + '\n', { mode: 0o600 });
  }
  console.log('Local administrator account created. Credentials saved only to the controlled local file.');
} catch {
  console.error('Local account creation failed. Inspect existing development accounts before retrying; credentials were not printed.');
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
