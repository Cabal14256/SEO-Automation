import { copyFile, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { candidates, git, ignoredFiles, inside, knownValues, printReport, privatePath, scanFiles, scanHistory } from './core.mjs';

export async function exportPublic({ repo, out }) {
  repo = await realpath(resolve(repo)); out = resolve(out);
  if (inside(repo, out) || inside(out, repo)) throw new Error('Export must be outside the source repository');
  try { await lstat(out); throw new Error('Export target already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Resolve existing parents before writing, so junctions cannot point back into source.
  const parent = await realpath(dirname(out)); const physicalOut = resolve(parent, out.split(/[\\/]/).at(-1));
  if (inside(repo, physicalOut) || inside(physicalOut, repo)) throw new Error('Export resolves inside the source repository');
  const values = await knownValues(repo); const sourceFiles = await candidates(repo); const ignored = await ignoredFiles(repo, sourceFiles);
  const files = sourceFiles.filter((path) => !privatePath(path) && !ignored.has(path));
  const findings = await scanFiles(repo, files, values);
  if (findings.length) return { result: 'failed', files: files.length, findings, created: false };
  await mkdir(physicalOut);
  for (const path of files) {
    const source = resolve(repo, path); let info;
    try { info = await lstat(source); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Public source must contain regular files only');
    if (!inside(repo, await realpath(source))) throw new Error('Public source resolves outside repository');
    const target = resolve(physicalOut, path);
    if (!inside(physicalOut, target)) throw new Error('Export path escapes target');
    await mkdir(dirname(target), { recursive: true }); await copyFile(source, target);
  }
  const copied = await scanFiles(physicalOut, files, values);
  if (copied.length) return { result: 'failed', findings: copied, created: true, target: physicalOut };
  await git(physicalOut, ['init', '--initial-branch=main']);
  await git(physicalOut, ['config', 'core.hooksPath', 'scripts/privacy/hooks']);
  await git(physicalOut, ['add', '--all']);
  if (files.includes('scripts/privacy/hooks/pre-push')) await git(physicalOut, ['update-index', '--chmod=+x', 'scripts/privacy/hooks/pre-push']);
  await git(physicalOut, ['-c', 'core.hooksPath=', '-c', 'user.name=SCM Public Export', '-c', 'user.email=public-export@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Initial sanitized public source']);
  const history = await scanHistory(physicalOut, values);
  if (history.findings.length) return { result: 'failed', findings: history.findings, created: true, target: physicalOut };
  const head = (await git(physicalOut, ['rev-parse', 'HEAD'])).toString('utf8').trim();
  return { result: 'passed', target: physicalOut, files: files.length, excludedPaths: sourceFiles.length - files.length, commits: 1, gitHead: head, remoteConfigured: false, originalRepositoryChanged: false, privateManifestLoaded: values.length > 0 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values: options } = parseArgs({ options: { repo: { type: 'string' }, out: { type: 'string' } } });
    if (!options.out) throw new Error('Usage: export.mjs --out new-directory [--repo source-directory]');
    const report = await exportPublic({ repo: options.repo ?? process.cwd(), out: options.out });
    printReport(report); if (report.result !== 'passed') process.exitCode = 1;
  } catch (error) { printReport({ result: 'failed', error: error.message }); process.exitCode = 1; }
}
