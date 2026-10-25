import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyInventory, sha256 } from '../trial/core.mjs';

try {
  const path = resolve(process.argv[2]);
  const bytes = await readFile(join(path, 'release-manifest.json'));
  const manifest = JSON.parse(bytes);
  if (manifest.format !== 'scm-trial-release/v1' || manifest.contentSha256 !== sha256(JSON.stringify(manifest.inventory))) throw new Error('Release manifest is invalid');
  await verifyInventory(path, [...manifest.inventory, { path: 'release-manifest.json', bytes: bytes.length, sha256: sha256(bytes) }]);
  const version = execFileSync(join(path, 'runtime/node.exe'), ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  const [major, minor, patch] = version.slice(1).split('.').map(Number);
  if (!/^v\d+\.\d+\.\d+$/.test(version) || major !== 24 || minor < 22 || (minor === 22 && patch < 1)) throw new Error('Release requires Node.js >=24.22.1 <25');
  console.log('Immutable release inventory verified.');
} catch {
  console.error('Release verification failed; the existing application is preserved.');
  process.exitCode = 1;
}
