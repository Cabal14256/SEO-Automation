import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { candidates, git, ignoredFiles, knownValues, printReport, scanFiles, scanHistory } from './core.mjs';

try {
  const { values: options } = parseArgs({ options: { repo: { type: 'string' }, history: { type: 'boolean' } } });
  const repo = resolve(options.repo ?? process.cwd());
  await git(repo, ['rev-parse', '--show-toplevel']);
  const files = await candidates(repo); const values = await knownValues(repo);
  const findings = await scanFiles(repo, files, values);
  const ignored = await ignoredFiles(repo, files);
  for (const path of ignored) if (!findings.some((finding) => finding.path === path)) findings.push({ path: 'tracked-file-covered-by-gitignore', line: 1, rule: 'tracked-ignored-file' });
  const history = options.history ? await scanHistory(repo, values) : { findings: [], scanned: 0 };
  printReport({ result: findings.length || history.findings.length ? 'failed' : 'passed', files: files.length, privateManifestLoaded: values.length > 0, historyObjects: history.scanned, findings: [...findings, ...history.findings], limitation: 'Pattern checks cannot identify every company name. Review new fixtures and keep private identifiers in the ignored local manifest.' });
  if (findings.length || history.findings.length) process.exitCode = 1;
} catch (error) { printReport({ result: 'failed', error: error.message }); process.exitCode = 1; }
