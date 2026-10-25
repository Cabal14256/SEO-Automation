import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const child = spawn(process.execPath, [resolve(repo, 'apps/server/node_modules/tsx/dist/cli.mjs'), resolve(repo, 'apps/server/src/physical-archive-acceptance.ts')], { cwd: repo, env: { ...process.env, LINGXING_REQUESTS_ENABLED: 'false' }, windowsHide: true, stdio: 'inherit' });
child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code) => { process.exitCode = code ?? 1; });
