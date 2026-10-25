import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { assertRuntimePath, assertSeparatePaths, containsPath, physicalPath } from './path-policy.mjs';

function fixture(action) {
  const root = mkdtempSync(join(tmpdir(), 'scm-path-policy-'));
  const repo = join(root, 'source'); mkdirSync(repo);
  try { return action(root, repo); }
  finally { assert(containsPath(tmpdir(), root, false)); rmSync(root, { recursive: true, force: true }); }
}

test('runtime roles allow designated private paths and compatible external directories', () => fixture((root, repo) => {
  for (const [role, name] of [['development', '.local/development'], ['data', '.local/development/data'], ['trial', '.local/trial'], ['release', '.local/trial/releases/r1'], ['restore', '.local/archive/restore-check']]) {
    const path = join(repo, name); assert.equal(assertRuntimePath(repo, path, role), path);
    assert.equal(assertRuntimePath(repo, join(root, `external-${role}`), role), join(root, `external-${role}`));
  }
  for (const name of ['', '.local', '.local-evil', 'apps', 'docs', '.local/archive/old-git', '.local/archive/public']) {
    for (const role of ['development', 'data', 'trial', 'release', 'restore']) assert.throws(() => assertRuntimePath(repo, join(repo, name), role), name);
  }
  assert.throws(() => assertRuntimePath(repo, join(repo, '.local/trial/releases'), 'release'));
  assert.throws(() => assertRuntimePath(repo, join(repo, '.local/trial/releases/r1'), 'trial'));
  assert.throws(() => assertRuntimePath(repo, join(repo, '.local/development/accounts.json'), 'data'));
  assert.throws(() => assertRuntimePath(repo, `${root}/../outside`, 'trial'));
  assert.throws(() => assertRuntimePath(repo, dirname(repo), 'development'));
  assert.throws(() => assertRuntimePath(repo, 'relative', 'development'));
  if (process.platform === 'win32') {
    assert.equal(assertRuntimePath(repo.toUpperCase(), join(repo, '.LOCAL/DEVELOPMENT/data'), 'development').toLowerCase(), join(repo, '.local/development/data').toLowerCase());
  }
}));

test('nearest-parent validation rejects junction escapes and aliases into source', () => fixture((root, repo) => {
  const outside = join(root, 'outside'); mkdirSync(outside);
  mkdirSync(join(repo, '.local')); symlinkSync(outside, join(repo, '.local/development'), 'junction');
  assert.throws(() => assertRuntimePath(repo, join(repo, '.local/development/new/data'), 'development'));
  const alias = join(root, 'source-alias'); symlinkSync(repo, alias, 'junction');
  assert.throws(() => assertRuntimePath(repo, join(alias, 'apps/new-data'), 'development'));
  assert.equal(physicalPath(join(alias, 'not-yet/created')), join(repo, 'not-yet/created'));
  const sourceFile = join(repo, 'existing-file'); writeFileSync(sourceFile, 'source');
  assert.throws(() => assertRuntimePath(repo, join(sourceFile, 'data'), 'development'));
  mkdirSync(join(repo, '.local/archive/public'), { recursive: true });
  symlinkSync(join(repo, '.local/archive/public'), join(repo, '.local/archive/restore-alias'), 'junction');
  assert.throws(() => assertRuntimePath(repo, join(repo, '.local/archive/restore-alias/new'), 'restore'));
}));

test('path separation rejects physical backup recursion and linked recovery keys', () => fixture((root) => {
  const data = join(root, 'data'); mkdirSync(data);
  const alias = join(root, 'data-alias'); symlinkSync(data, alias, 'junction');
  assert.throws(() => assertSeparatePaths(join(alias, 'backup'), [data]));
  assert.throws(() => assertSeparatePaths(join(alias, 'recovery.key'), [data]));
  assert.throws(() => assertSeparatePaths(root, [data]));
  assert.equal(assertSeparatePaths(join(root, 'separate'), [data]), join(root, 'separate'));
}));

test('PowerShell wrapper uses the same role policy', { skip: process.platform !== 'win32' }, () => fixture((root, repo) => {
  const helper = resolve(import.meta.dirname, 'path-policy.ps1').replaceAll("'", "''");
  const check = (path) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; . '${helper}'; Resolve-ScmRuntimePath -Repository '${repo.replaceAll("'", "''")}' -Path '${path.replaceAll("'", "''")}' -Role development`], { encoding: 'utf8', windowsHide: true });
  const good = join(repo, '.local/development/postgres'); const accepted = check(good);
  assert.equal(accepted.status, 0, accepted.stderr); assert.equal(accepted.stdout.trim(), good);
  assert.notEqual(check(join(repo, 'apps/data')).status, 0);
}));

test('PowerShell validation accepts resolved Node and supported fallback when PATH omits Node', { skip: process.platform !== 'win32' }, () => fixture((root, repo) => {
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const helper = resolve(import.meta.dirname, 'path-policy.ps1');
  const good = join(repo, '.local/development/postgres');
  const programFiles = join(root, 'program files'); const fallback = join(programFiles, 'nodejs/node.exe');
  mkdirSync(dirname(fallback), { recursive: true }); copyFileSync(process.execPath, fallback);
  const run = (explicit) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; . ${quote(helper)}; $env:PATH=''; $env:ProgramFiles=${quote(programFiles)}; $env:USERPROFILE=${quote(root)}; Resolve-ScmRuntimePath -Repository ${quote(repo)} -Path ${quote(good)} -Role development ${explicit ? `-NodeExecutable ${quote(process.execPath)}` : ''}; Resolve-ScmPhysicalPath -Path ${quote(good)} ${explicit ? `-NodeExecutable ${quote(process.execPath)}` : ''}`], { encoding: 'utf8', windowsHide: true });
  for (const explicit of [true, false]) {
    const result = run(explicit); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), [good, good]);
  }
}));
