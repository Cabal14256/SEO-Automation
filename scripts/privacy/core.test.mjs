import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { candidates, git, inside, knownValues, privatePath, scanContent, scanFiles, scanHistory } from './core.mjs';
import { exportPublic } from './export.mjs';

async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'scm-privacy-'));
  try {
    const repo = join(root, 'source'); await mkdir(repo);
    await git(repo, ['init', '--initial-branch=main']);
    await git(repo, ['config', 'user.name', 'Privacy Test']);
    await git(repo, ['config', 'user.email', 'privacy-test@example.invalid']);
    await action(root, repo);
  } finally { assert(inside(tmpdir(), root)); await rm(root, { recursive: true, force: true }); }
}
async function file(repo, path, text) {
  const target = join(repo, path); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, text);
}
async function commit(repo, message = 'Synthetic fixture') {
  await git(repo, ['add', '--all']); await git(repo, ['-c', 'commit.gpgSign=false', 'commit', '-m', message]);
}
test('public boundaries preserve readmes and reject originals, runtime, credential and archive files', () => {
  for (const path of ['docs/research/README.md', 'docs/private/README.md', 'docs/acceptance/evidence/README.md', '.env.example', 'apps/server/src/parser.test.ts']) assert.equal(privatePath(path), false, path);
  for (const path of ['docs/research/any/raw.md', 'docs/acceptance/evidence/screenshot.png', 'docs/private/source.xlsx', 'docs/templates/import.xlsx', '.local/privacy/known-values.json', 'apps/server/.env', 'scripts/probe.local.json', 'archive.zip', 'database.sqlite3-wal', 'apps/server/dist/api.js']) assert.equal(privatePath(path), true, path);
});
test('patterns and private manifest catch identifiers without printing matching content', () => {
  const shipment = `FBA${'1A2B3C4D5E'}`;
  const asin = `B0${'1A2B3C4D'}`;
  const fnsku = `X00${'1A2B3C4'}`;
  const marker = ['Private', 'Seller'].join(' ');
  const bytes = Buffer.from(`header\n${shipment} ${asin} ${fnsku}\n${marker}\nsid: 9091\nnotSid: 190919\n`);
  const findings = scanContent('fixture.ts', bytes, [marker, '9091']);
  assert.equal(findings.filter((item) => item.rule === 'private-known-value').length, 2);
  assert.equal(findings.filter((item) => /identifier$/.test(item.rule)).length, 3);
  assert(!JSON.stringify(findings).includes(shipment)); assert(!JSON.stringify(findings).includes(marker));
  assert.deepEqual(scanContent('demo.ts', Buffer.from('FBADEMO00001 FBATEST00001 B0TEST0001 test@example.invalid')), []);
  assert.equal(scanContent('fixture.ts', Buffer.from(marker.toUpperCase()), [marker]).at(0).rule, 'private-known-value');
  const fullwidth = marker.replace(/[A-Za-z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 0xfee0));
  assert.equal(scanContent('fixture.ts', Buffer.from(fullwidth), [marker]).at(0).rule, 'private-known-value');
  assert.equal(scanContent('fixture.ts', Buffer.from(`İ\n${fullwidth.toLowerCase()}\n`), [marker]).at(0).line, 2);
  assert.equal(scanContent('fixture.ts', Buffer.from(shipment.toLowerCase())).at(0).rule, 'shipment-identifier');
  const fullwidthShipment = shipment.replace(/[A-Za-z0-9]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 0xfee0));
  assert.equal(scanContent('fixture.ts', Buffer.from(fullwidthShipment)).at(0).rule, 'shipment-identifier');
});
test('credential and binary checks allow explicit placeholders and reject real-shaped tokens', () => {
  assert.equal(scanContent('file', Buffer.from([0xff, 0xd8, 0xff])).at(0).rule, 'unreviewed-binary');
  const token = `ghp_${'A'.repeat(36)}`;
  assert.equal(scanContent('file', Buffer.from(token)).at(0).rule, 'access-token');
  assert.equal(scanContent('file', Buffer.from(`CLIENT_SECRET=${'a'.repeat(32)}`)).at(0).rule, 'credential-literal');
  assert.equal(scanContent('file.json', Buffer.from(JSON.stringify({ accessToken: 'a'.repeat(32) }))).at(0).rule, 'credential-literal');
  assert.deepEqual(scanContent('.env.example', Buffer.from('CLIENT_SECRET=replace-with-your-own-secret-0000\nCONTACT=demo@example.invalid')), []);
  const upstreamContact = ['maintainer', 'upstream.dev'].join('@');
  assert.deepEqual(scanContent('pnpm-lock.yaml', Buffer.from(`  deprecated: Contact ${upstreamContact}`)), []);
  assert.equal(scanContent('pnpm-lock.yaml', Buffer.from(`  custom: ${upstreamContact}`)).at(0).rule, 'contact-email');
  const publicIdentity = 'synthetic@users.noreply.github.com';
  assert.deepEqual(scanContent('commit', Buffer.from(publicIdentity)), []);
  assert.equal(scanContent('commit', Buffer.from(publicIdentity), [publicIdentity]).at(0).rule, 'private-known-value');
});
test('repository scan covers tracked ignored artifacts and untracked public files', () => fixture(async (_, repo) => {
  await file(repo, 'docs/research/raw.md', 'private input'); await commit(repo);
  await file(repo, '.gitignore', 'docs/research/**\n.local/\n');
  await file(repo, 'new-source.ts', 'export const synthetic = true;');
  await file(repo, '.local/privacy/known-values.json', JSON.stringify({ format: 'scm-private-values/v1', values: ['Synthetic Hidden Name'] }));
  const files = await candidates(repo);
  assert(files.includes('new-source.ts')); assert(!files.includes('.local/privacy/known-values.json'));
  assert.equal((await knownValues(repo)).length, 1);
  assert((await scanFiles(repo, files)).some((finding) => finding.rule === 'private-or-generated-path'));
}));
test('history inspection catches a private source removed from the current tree', () => fixture(async (_, repo) => {
  await file(repo, 'docs/research/raw.md', 'private input'); await commit(repo);
  await rm(join(repo, 'docs/research/raw.md')); await file(repo, 'source.ts', 'export {};'); await commit(repo);
  assert.deepEqual(await scanFiles(repo, await candidates(repo)), []);
  assert((await scanHistory(repo)).findings.some((finding) => finding.rule === 'private-history-path'));
}));
test('private filenames are blocked and redacted from working tree and history reports', () => fixture(async (_, repo) => {
  const marker = ['Synthetic', 'SensitiveName'].join('-');
  const path = `${marker}.md`; await file(repo, path, 'safe contents'); await commit(repo);
  const report = await scanFiles(repo, await candidates(repo), [marker]);
  assert.equal(report.at(0).rule, 'sensitive-filename'); assert(!JSON.stringify(report).includes(marker));
  const history = await scanHistory(repo, [marker]);
  assert(history.findings.some((finding) => finding.rule === 'sensitive-history-filename'));
  assert(!JSON.stringify(history).includes(marker));
}));
test('public export omits private files and creates one independent commit with no remote', () => fixture(async (root, repo) => {
  await file(repo, '.gitignore', '.local/\ndocs/research/**\n');
  await file(repo, 'source.ts', 'export const synthetic = true;'); await commit(repo);
  await file(repo, 'source.ts', 'export const synthetic = false;'); await commit(repo);
  await file(repo, 'docs/research/raw.md', 'ignored private input');
  await file(repo, 'new-source.ts', 'export {};');
  const oldHead = await git(repo, ['rev-parse', 'HEAD']);
  const out = join(root, 'public'); const report = await exportPublic({ repo, out });
  assert.equal(report.result, 'passed'); assert.equal((await git(out, ['rev-list', '--count', 'HEAD'])).toString().trim(), '1');
  assert.equal((await git(out, ['remote'])).toString().trim(), '');
  assert.deepEqual(await git(repo, ['rev-parse', 'HEAD']), oldHead);
  assert.equal(await readFile(join(out, 'new-source.ts'), 'utf8'), 'export {};');
  assert(!(await candidates(out)).includes('docs/research/raw.md'));
  await assert.rejects(exportPublic({ repo, out }), /already exists/);
  await assert.rejects(exportPublic({ repo, out: join(repo, 'public') }), /outside/);
}));
test('public export refuses source containing private identifiers before creating output', () => fixture(async (root, repo) => {
  const marker = ['Synthetic', 'Blocked Seller'].join(' ');
  await file(repo, '.gitignore', '.local/\n');
  await file(repo, 'source.ts', JSON.stringify(marker));
  await file(repo, '.local/privacy/known-values.json', JSON.stringify({ format: 'scm-private-values/v1', values: [marker] }));
  const report = await exportPublic({ repo, out: join(root, 'public') });
  assert.equal(report.result, 'failed'); assert.equal(report.created, false);
  assert(!JSON.stringify(report).includes(marker));
}));
test('directory junctions cannot expose private files outside the repository', () => fixture(async (root, repo) => {
  await file(repo, 'linked/source.ts', 'export {};'); await commit(repo);
  const outside = join(root, 'private'); await mkdir(outside); await writeFile(join(outside, 'source.ts'), 'external private input');
  assert(inside(repo, join(repo, 'linked'))); await rm(join(repo, 'linked'), { recursive: true });
  await symlink(outside, join(repo, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const findings = await scanFiles(repo, await candidates(repo));
  assert.equal(findings.at(0).rule, 'linked-source-outside-repository');
  const report = await exportPublic({ repo, out: join(root, 'public') });
  assert.equal(report.result, 'failed'); assert.equal(report.created, false);
}));
