import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

// The former monolithic suite exercised retired week-based source selection,
// physical confirmation and price-confirmation forms. Run the current focused
// fixture suites serially so Canvas checks exercise real row navigation and so
// Chrome processes are released before the next suite starts.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.M4_BROWSER_EVIDENCE_DIR || resolve(root, '.local/m4/frontend'));
const startedAt = new Date().toISOString();
const definitions = [
  { name: 'document-grid', script: 'document-grid-browser.mjs', directory: '.local/m4/document-grid', env: 'DOCUMENT_GRID_EVIDENCE_DIR' },
  { name: 'source-selection', script: 'documents-source-browser.mjs', directory: '.local/m4/source-selection', env: 'DOCUMENT_SOURCE_EVIDENCE_DIR' },
  { name: 'box-values', script: 'box-values-browser.mjs', directory: '.local/m4/box-values' },
  { name: 'invoice-v2', script: 'invoice-v2-browser.mjs', directory: '.local/m4/invoice-v2', env: 'M4_INVOICE_V2_EVIDENCE_DIR' },
  { name: 'document-details', script: 'document-details-browser.mjs', directory: '.local/m4/document-details', env: 'DOCUMENT_DETAILS_EVIDENCE_DIR' },
  { name: 'document-defaults', script: 'document-defaults-browser.mjs', directory: '.local/m4/document-defaults', env: 'DOCUMENT_DEFAULTS_EVIDENCE_DIR' },
  { name: 'document-automation', script: 'document-automation-browser.mjs', directory: '.local/m4/document-batch-preflight', env: 'DOCUMENT_AUTOMATION_EVIDENCE_DIR' },
  { name: 'document-manual-price', script: 'document-manual-price-browser.mjs', directory: '.local/m4/manual-selling-price', env: 'MANUAL_PRICE_EVIDENCE_DIR' },
  { name: 'document-deletion', script: 'document-deletion-browser.mjs', directory: '.local/m4/document-deletion', env: 'DOCUMENT_DELETION_EVIDENCE_DIR' },
];
const suites = [];
let currentChild;
let interrupted = false;
const interrupt = () => { interrupted = true; currentChild?.kill(); };
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

async function saveReport(complete) {
  const passed = complete && !interrupted && suites.length === definitions.length && suites.every((suite) => suite.passed);
  await mkdir(evidence, { recursive: true });
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({
    kind: 'fixture-only-m4-vtable-browser', startedAt, completedAt: complete ? new Date().toISOString() : null,
    complete, passed, suites,
    checksPassed: suites.reduce((sum, suite) => sum + suite.checksPassed, 0),
    checksTotal: suites.reduce((sum, suite) => sum + suite.checksTotal, 0),
    realBusinessWrites: 0, externalServiceRequests: 0,
  }, null, 2) + '\n');
  return passed;
}

await saveReport(false);
for (const definition of definitions) {
  if (interrupted) break;
  const beginning = Date.now();
  const script = resolve(root, 'scripts/m4', definition.script);
  const reportPath = resolve(definition.env && process.env[definition.env] || resolve(root, definition.directory), 'result.json');
  console.log(`RUN ${definition.name}`);
  const execution = await new Promise((done) => {
    currentChild = spawn(process.execPath, [script], { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
    currentChild.once('error', (error) => done({ exitCode: 1, error: error.message }));
    currentChild.once('exit', (code, signal) => done({ exitCode: code ?? 1, ...(signal ? { signal } : {}) }));
  });
  currentChild = undefined;
  let report;
  let fresh = false;
  let reportError;
  try {
    const metadata = await stat(reportPath);
    fresh = metadata.mtimeMs >= beginning - 2000;
    report = JSON.parse(await readFile(reportPath, 'utf8'));
    if (!fresh) reportError = 'The suite did not produce a new evidence report.';
  } catch (error) { reportError = error.message; }
  const checks = fresh && Array.isArray(report?.checks) ? report.checks : [];
  const passed = execution.exitCode === 0 && fresh && report?.passed === true && checks.length > 0 && checks.every((check) => check.passed === true);
  suites.push({
    name: definition.name, script: relative(root, script).replaceAll('\\', '/'), passed,
    ...execution, durationMs: Date.now() - beginning,
    evidence: relative(root, reportPath).replaceAll('\\', '/'), freshEvidence: fresh,
    checksPassed: checks.filter((check) => check.passed === true).length, checksTotal: checks.length,
    ...(reportError ? { reportError } : {}),
  });
  console.log(`${passed ? 'PASS' : 'FAIL'} SUITE ${definition.name} (${checks.filter((check) => check.passed === true).length}/${checks.length})`);
  await saveReport(false);
}

const passed = await saveReport(true);
process.off('SIGINT', interrupt);
process.off('SIGTERM', interrupt);
console.log(`${passed ? 'PASS' : 'FAIL'} M4 browser suites ${suites.filter((suite) => suite.passed).length}/${definitions.length}`);
if (!passed) process.exitCode = 1;
