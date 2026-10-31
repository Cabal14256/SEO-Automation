import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectDemandWorkspace } from '../../apps/server/src/modules/imports/workspace-projection.ts';

// Run through the server's tsx loader; fixtures never open a database or network connection.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactDirectory = resolve(root, '.local/vtable/backend');
const projectionPath = 'apps/server/src/modules/imports/workspace-projection.ts';
const at = '2026-10-30T00:00:00.000Z';
const query = { page: 1, pageSize: 20, pageBy: 'demand', lifecycle: 'active' };
let nextId = 1;
const uuid = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;

function options() {
  const result = { baseline: null, iterations: 3, output: resolve(artifactDirectory, 'workspace-performance-current.json') };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      console.log('Usage: tsx scripts/vtable/workspace-benchmark.mjs [--baseline <git-ref>] [--iterations <1..20>] [--output <path>]');
      process.exit(0);
    }
    if (!['--baseline', '--iterations', '--output'].includes(argument) || !args[index + 1]) throw new Error(`Unknown or incomplete argument: ${argument}`);
    const value = args[++index];
    if (argument === '--baseline') result.baseline = value;
    else if (argument === '--iterations') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 20) throw new Error('--iterations must be an integer from 1 to 20');
      result.iterations = Number(value);
    } else result.output = isAbsolute(value) ? value : resolve(root, value);
  }
  return result;
}

function fixture(demandCount, boxCount) {
  const input = { demands: [], members: [], groups: [], shipments: [], confirmations: [], codes: [], decisions: [], batches: [], sources: [], shippingMemberships: [] };
  const batchId = uuid(), runId = uuid();
  input.batches.push({ id: batchId, weekStartDate: '2026-10-26', weekEndDate: '2026-11-01', version: 1, sortMode: 'fba', nextPrefix: 0, createdAt: at });
  for (let index = 0; index < demandCount; index++) {
    const demandId = uuid(), revisionId = uuid(), groupId = uuid();
    const demand = { id: demandId, version: 1, businessDate: '2026-10-30', weekStartDate: '2026-10-26', weekEndDate: '2026-11-01', createdAt: at, updatedAt: at,
      snapshot: { sid: 101, fba: `FBATEST${String(index).padStart(8, '0')}`, shop: 'Synthetic shop', country: '美国', channel: 'SEA', destinationFc: 'TEST1', referenceQuantity: String(boxCount), notes: null, subBatchName: null } };
    const items = Array.from({ length: 10 }, (_, product) => ({ msku: `M${product}`, fnsku: `F${product}`, sku: `S${product}`, name: `Product ${product}`, quantity: String(boxCount / 10) }));
    const boxes = Array.from({ length: boxCount }, (_, box) => ({ id: uuid(), externalBoxId: null, packageId: null, localBoxId: String(box + 1), name: null, order: box + 1,
      weight: '1.25', weightUnit: 'KG', length: '30', width: '20', height: '10', dimensionUnit: 'CM', items: [{ ...items[box % 10], quantity: '1' }] }));
    const revision = { id: revisionId, demandId, version: 1, demandVersion: 1, source: 'manual', snapshotIds: [], reason: 'Synthetic benchmark', createdBy: 'benchmark', createdAt: at,
      data: { sid: 101, fba: demand.snapshot.fba, observedAt: at, items, boxes, issues: [] } };
    input.demands.push(demand); input.shipments.push(revision);
    input.groups.push({ id: groupId, batchId, name: `Group ${index}`, version: 1, status: 'frozen', confirmedVersion: 1, frozenAt: at, actualShipDate: null, updatedAt: at });
    input.members.push({ demandId, groupId, batchId, demandVersion: 1 });
    input.confirmations.push({ id: uuid(), groupId, groupVersion: 1, snapshot: { members: [demand], shipments: [{ demandId, revision }], ruleVersion: 'shipment-detail-quantity-v1' }, createdBy: 'benchmark', createdAt: at });
    input.shippingMemberships.push({ demandId, groupId, runId, month: '2026-10', sequence: 1, numberingDate: '2026-10-30', ticketNumber: `20261030-1-US-${index}` });
    for (const [boxIndex, box] of boxes.entries()) input.codes.push({ id: uuid(), groupId, demandId, boxId: box.id, prefix: 'A', sequence: boxIndex + 1, code: `A${boxIndex + 1}`, valid: true, createdAt: at });
  }
  return input;
}

async function baseline(reference) {
  if (!reference) return null;
  if (reference.startsWith('-') || /[\r\n\0]/.test(reference)) throw new Error('Invalid baseline git reference');
  // Git is invoked without a shell. Resolve to an immutable commit before reading source.
  const commit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${reference}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
  const source = execFileSync('git', ['show', `${commit}:${projectionPath}`], { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  const originalDirectory = dirname(resolve(root, projectionPath));
  const rewritten = source.replace(/(from\s+)(['"])([^'"]+)\2/g, (match, prefix, quote, specifier) => {
    let target;
    if (specifier === '@scm/contracts') target = resolve(root, 'packages/contracts/src/index.ts');
    else if (specifier.startsWith('.')) {
      target = resolve(originalDirectory, specifier);
      if (target.endsWith('.js') && existsSync(target.slice(0, -3) + '.ts')) target = target.slice(0, -3) + '.ts';
    } else return match;
    return `${prefix}${quote}${pathToFileURL(target).href}${quote}`;
  });
  await mkdir(artifactDirectory, { recursive: true });
  const temporarySource = resolve(artifactDirectory, `workspace-baseline-${commit}.mts`);
  await writeFile(temporarySource, rewritten);
  const module = await import(pathToFileURL(temporarySource).href);
  if (typeof module.projectDemandWorkspace !== 'function') throw new Error(`Baseline ${commit} does not export projectDemandWorkspace`);
  return { commit, project: module.projectDemandWorkspace };
}

const rounded = (value) => Math.round(value * 10) / 10;
const median = (values) => { const sorted = [...values].sort((left, right) => left - right), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : rounded((sorted[middle - 1] + sorted[middle]) / 2); };

async function main() {
  const config = options(), previous = await baseline(config.baseline), cases = [];
  for (const [demands, columns] of [[1000, 50], [5000, 100]]) {
    const input = fixture(demands, columns), currentSamples = [], baselineSamples = [];
    let output;
    for (let iteration = 0; iteration < config.iterations; iteration++) {
      let prior;
      if (previous) {
        const start = performance.now(); prior = previous.project(input, query, at); baselineSamples.push(rounded(performance.now() - start));
      }
      const start = performance.now(); output = projectDemandWorkspace(input, query, at); currentSamples.push(rounded(performance.now() - start));
      assert.equal(output.total, demands * 10); assert.equal(output.demandTotal, demands); assert.equal(output.rows.length, 200);
      if (prior) assert.deepStrictEqual(output, prior, `Full response mismatch: ${demands * 10} product rows, iteration ${iteration + 1}`);
    }
    const result = { inputDemands: demands, productRows: demands * 10, boxColumns: columns, iterations: config.iterations,
      currentMs: currentSamples, currentMedianMs: median(currentSamples),
      ...(previous ? { baselineMs: baselineSamples, baselineMedianMs: median(baselineSamples), ratio: rounded(median(baselineSamples) / median(currentSamples)), fullResponseParity: true } : {}),
      responseBytes: Buffer.byteLength(JSON.stringify(output)), outputRows: output.rows.length };
    cases.push(result); console.log(JSON.stringify(result));
  }
  await mkdir(dirname(config.output), { recursive: true });
  await writeFile(config.output, JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, baselineCommit: previous?.commit ?? null,
    note: 'Synthetic pure projection benchmark; no SQL/network/filesystem I/O is included in timings. Baseline uses the historical projection with current domain helper modules.', cases }, null, 2) + '\n');
  console.log(`Report: ${config.output}`);
}

main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
