import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
export async function git(repo, args, input, acceptedCodes = [0]) {
  return new Promise((accept, reject) => {
    const process = spawn('git', ['-C', repo, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = []; let size = 0; let exceeded = false;
    process.on('error', () => reject(new Error('Git operation could not start')));
    process.stdout.on('data', (chunk) => { size += chunk.length; if (size > 128 * 1024 * 1024) { exceeded = true; process.kill(); } else chunks.push(chunk); });
    process.on('close', (code) => {
      // Git stderr can contain a private path or URL. Expose only the exit code.
      if (exceeded || !acceptedCodes.includes(code)) reject(new Error(`Git operation failed (${exceeded ? 'output limit' : code})`));
      else accept(Buffer.concat(chunks));
    });
    process.stdin.on('error', () => {});
    process.stdin.end(input);
  });
}
export function inside(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}
export function privatePath(path) {
  path = path.replaceAll('\\', '/');
  if (/^docs\/(?:research|acceptance\/evidence)\/README\.md$/i.test(path)) return false;
  return /(?:^|\/)(?:\.git|\.local|\.vite|node_modules|dist|data|private|coverage|test-results|playwright-report|__pycache__)(?:\/|$)/i.test(path)
    || /^docs\/(?:research|acceptance\/evidence|templates)\//i.test(path)
    || /(?:^|\/)\.env(?:\.(?!example$)[^/]*)?$/i.test(path)
    || /\.local\.json$/i.test(path)
    || /\.(?:key|pem|pfx|p12|db|sqlite3?|dump|backup|scmbak|bundle|log|pid|pyc|tsbuildinfo|xlsx?|xlsm|csv|tsv|docx|pdf|zip|rar|7z|tar|gz|tgz)(?:-(?:wal|shm))?$/i.test(path);
}
export async function candidates(repo) {
  const listed = await git(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  return [...new Set(listed.toString('utf8').split('\0').filter(Boolean))].sort();
}
export async function ignoredFiles(repo, files) {
  if (!files.length) return new Set();
  const listed = await git(repo, ['check-ignore', '--no-index', '--stdin', '-z'], Buffer.from(files.join('\0') + '\0'), [0, 1]);
  return new Set(listed.toString('utf8').split('\0').filter(Boolean));
}
export async function knownValues(repo) {
  let data;
  try { data = JSON.parse(await readFile(resolve(repo, '.local/privacy/known-values.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw new Error('Private identifier manifest is unreadable'); }
  if (data.format !== 'scm-private-values/v1' || !Array.isArray(data.values) || data.values.some((value) => typeof value !== 'string' || value.length < 4)) throw new Error('Invalid private identifier manifest');
  return [...new Set(data.values)];
}
function placeholder(value) {
  return /^(?:test|offline|demo|example|replace|change[-_]me|your[-_]|m\d+-isolated-technical-acceptance|\$\{|<)/i.test(value);
}
function lineAt(text, offset) { return text.slice(0, offset).split('\n').length; }
export function scanContent(path, bytes, values = []) {
  const results = [];
  if (bytes.includes(0) || bytes.subarray(0, 16).some((byte) => byte < 9 || (byte > 13 && byte < 32))) return [{ path, line: 1, rule: 'unreviewed-binary' }];
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).normalize('NFKC'); }
  catch { return [{ path, line: 1, rule: 'unreviewed-binary' }]; }
  const seen = new Set();
  function report(rule, offset, source = text) {
    const line = lineAt(source, offset); const key = `${rule}:${line}`;
    if (!seen.has(key)) { seen.add(key); results.push({ path, line, rule }); }
  }
  const rules = [
    ['shipment-identifier', /\bFBA\d[A-Z0-9]{7,15}\b/gi],
    ['asin-identifier', /\bB0[A-Z0-9]{8}\b/gi],
    ['fnsku-identifier', /\bX00[A-Z0-9]{7}\b/gi],
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
    ['access-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[A-Z0-9]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{30,})\b/g],
  ];
  for (const [rule, expression] of rules) for (const match of text.matchAll(expression)) {
    if (rule === 'asin-identifier' && /^B0(?:TEST|DEMO)\d{4}$/i.test(match[0])) continue;
    report(rule, match.index);
  }
  for (const match of text.matchAll(/(?:LINGXING_APP_SECRET|LINGXING_ACCESS_TOKEN|BETTER_AUTH_SECRET|PGPASSWORD|API_KEY|(?:APP|CLIENT)[_-]?SECRET|(?:ACCESS|REFRESH)[_-]?TOKEN)['"]?\s*[:=]\s*['"]?([A-Za-z0-9+/_=-]{24,})/gi)) if (!placeholder(match[1])) report('credential-literal', match.index);
  for (const match of text.matchAll(/[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,}/gi)) {
    // Registry deprecation notices are upstream dependency metadata. Other
    // lockfile fields still receive the normal checks, including known values.
    const line = text.slice(text.lastIndexOf('\n', match.index) + 1, text.indexOf('\n', match.index) < 0 ? text.length : text.indexOf('\n', match.index));
    if (/(?:^|:)pnpm-lock\.yaml$/.test(path) && /^\s+deprecated:\s/.test(line)) continue;
    const domain = match[0].split('@').at(-1).toLowerCase();
    // GitHub private identities and its exact web-commit bot address are public
    // metadata. Known private values below still take precedence over this rule.
    if (domain === 'users.noreply.github.com' || match[0].toLowerCase() === 'noreply@github.com') continue;
    if (!/(?:^|\.)(?:example\.(?:com|org|net|invalid)|localhost|invalid|test|local)$/.test(domain)) report('contact-email', match.index);
  }
  for (const match of text.matchAll(/[\p{Script=Han}]{2,}(?:有限责任公司|有限公司|股份公司)/gu)) if (!/(?:示例|测试|演示|虚构|模拟)/.test(match[0])) report('company-legal-name', match.index);
  const folded = text.toLowerCase();
  for (const original of values) {
    const value = original.normalize('NFKC').toLowerCase();
    let offset = -1;
    while ((offset = folded.indexOf(value, offset + 1)) !== -1) {
      // Numeric SIDs match whole identifiers, not a fragment of a timestamp/hash.
      if (/^\d+$/.test(value) && (/[\w]/.test(text[offset - 1] ?? '') || /[\w]/.test(text[offset + value.length] ?? ''))) continue;
      report('private-known-value', offset, folded);
    }
  }
  return results;
}
export async function scanFiles(repo, files, values = []) {
  const findings = []; const physicalRepo = await realpath(repo);
  for (const path of files) {
    const absolute = resolve(repo, path);
    if (!inside(repo, absolute)) throw new Error('Candidate path escapes repository');
    let info;
    try { info = await lstat(absolute); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (scanContent('filename', Buffer.from(path), values).length) { findings.push({ path: `filename:${digest(path).slice(0, 12)}`, line: 1, rule: 'sensitive-filename' }); continue; }
    if (privatePath(path)) { findings.push({ path, line: 1, rule: 'private-or-generated-path' }); continue; }
    if (info.isSymbolicLink() || !info.isFile()) { findings.push({ path, line: 1, rule: 'nonregular-file' }); continue; }
    if (!inside(physicalRepo, await realpath(absolute))) { findings.push({ path, line: 1, rule: 'linked-source-outside-repository' }); continue; }
    if (info.size > 8 * 1024 * 1024) { findings.push({ path, line: 1, rule: 'oversized-file-review-required' }); continue; }
    findings.push(...scanContent(path, await readFile(absolute), values));
  }
  return findings;
}
export async function scanHistory(repo, values = []) {
  let objects;
  try { objects = await git(repo, ['rev-list', '--objects', '--all']); } catch { throw new Error('History could not be inspected'); }
  const findings = []; let scanned = 0;
  const records = objects.toString('utf8').split('\n').filter(Boolean).map((record) => /^([a-f0-9]{40,64})(?: (.*))?$/.exec(record)).filter(Boolean);
  const sizes = (await git(repo, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], records.map((match) => match[1]).join('\n') + '\n')).toString('utf8').trim().split('\n');
  const inspect = [];
  for (let index = 0; index < records.length; index++) {
    const [, oid, path] = records[index]; const [, type, size] = sizes[index].split(' ');
    if (!['blob', 'commit', 'tag'].includes(type)) continue;
    const sensitiveFilename = path && scanContent('filename', Buffer.from(path), values).length > 0;
    const label = `history:${oid.slice(0, 12)}${path ? `:${sensitiveFilename ? '<private-filename>' : path}` : ''}`;
    if (sensitiveFilename) findings.push({ path: label, line: 1, rule: 'sensitive-history-filename' });
    // This exact, reviewed public notice was tracked before docs/private became
    // entirely local. Keep inspecting its contents without allowing any new
    // private README, any other path, or this file in the current tree/export.
    const legacyPublicNotice = path === 'docs/private/README.md' && oid === 'a037a5d4f8cc0287d94d0c3b6312632cfe215409';
    if (path && privatePath(path) && !legacyPublicNotice) { findings.push({ path: label, line: 1, rule: 'private-history-path' }); continue; }
    if (Number(size) > 8 * 1024 * 1024) { findings.push({ path: label, line: 1, rule: 'oversized-history-object' }); continue; }
    inspect.push({ oid, label });
  }
  // Bound batches so many individually valid large files cannot exhaust memory.
  for (let start = 0; start < inspect.length; start += 12) {
    const batch = inspect.slice(start, start + 12);
    const content = await git(repo, ['cat-file', '--batch'], batch.map((record) => record.oid).join('\n') + '\n');
    let offset = 0;
    for (const record of batch) {
      const end = content.indexOf(10, offset); if (end < 0) throw new Error('Incomplete history object');
      const [oid, , size] = content.subarray(offset, end).toString('utf8').split(' ');
      if (oid !== record.oid || !/^\d+$/.test(size)) throw new Error('Invalid history object');
      const bytes = content.subarray(end + 1, end + 1 + Number(size)); offset = end + 2 + Number(size);
      findings.push(...scanContent(record.label, bytes, values)); scanned++;
    }
  }
  return { findings, scanned };
}
export function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function printReport(report) {
  // Never log file contents, private identifiers, Git stderr or credentials.
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
