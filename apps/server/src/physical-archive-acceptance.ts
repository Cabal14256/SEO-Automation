import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { Decimal } from 'decimal.js';
import { PHYSICAL_RULE_VERSION, type GroupConfirmation, type PhysicalConfirmation } from '@scm/contracts';
import type { LingxingReadPayload } from './modules/lingxing/read-client.js';
import { fetchCompleteShipmentList, normalizeShipment } from './modules/batches/sync.js';
import { validateShipmentData } from './modules/batches/validation.js';
import { buildPhysicalSource, pendingEntries } from './modules/physical/domain.js';
import { createPhysicalWorkbook } from './modules/physical/workbook.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), output = resolve(repo, '.local/m3');
const technicalLabel = '技术离线复算_非实物核对_未签收';
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('External transport is forbidden in offline archive recalculation'); };
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
type Archived = { file: string; sha256: string; run: string; runAt: string; sid: number; fba: string; operation: 'list' | 'details' | 'packing'; params: Record<string, unknown>; response: LingxingReadPayload; attempt: number };
function runTime(directory: string) { const match = /run-(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z/.exec(directory); return match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z` : null; }
async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...await files(resolve(directory, entry.name)));
    else if (entry.isFile() && /[\\/]raw$/.test(directory) && entry.name.endsWith('.json')) result.push(resolve(directory, entry.name));
  }
  return result;
}

const before = new Map<string, string>(), archived: Archived[] = [], ignored: { path: string; reason: string }[] = [];
const selections: { sid: number; fba: string; run: string; observedAt: string; files: { path: string; sha256: string }[]; boxes: number; itemRows: number; po: string | null }[] = [];
const rejected: { sid: number; fba: string; run: string; reason: string }[] = [], confirmations: PhysicalConfirmation[] = [];
try {
  for (const root of ['data/lingxing-probe', 'data/lingxing-reference-check']) for (const file of await files(resolve(repo, root))) {
    const bytes = await readFile(file); before.set(file, hash(bytes));
    const raw = object(JSON.parse(bytes.toString('utf8'))), params = object(raw.params), response = object(raw.response);
    const operation = String(raw.path).endsWith('/shipmentList') ? 'list' : String(raw.path).endsWith('/shipmentDetailList') ? 'details' : String(raw.path).endsWith('/listShipmentBoxes') ? 'packing' : null;
    if (!operation) continue;
    const sid = Number(params.sid), fba = String(operation === 'list' ? params.shipment_id : params.shipmentConfirmationId).trim().toUpperCase();
    const run = dirname(dirname(file)), runAt = runTime(run);
    if (!Number.isSafeInteger(sid) || sid <= 0 || !/^FBA[A-Z0-9]+$/.test(fba) || !runAt || Number(raw.httpStatus) < 200 || Number(raw.httpStatus) >= 300 || String(response.code) !== '0') {
      ignored.push({ path: relative(repo, file).replaceAll('\\', '/'), reason: 'Not a successful uniquely addressed archive response' }); continue;
    }
    archived.push({ file, sha256: before.get(file)!, run, runAt, sid, fba, operation, params, response: response as LingxingReadPayload, attempt: Number(raw.attempt) || 0 });
  }
  const groups = new Map<string, Archived[]>();
  for (const record of archived) { const key = JSON.stringify([record.sid, record.fba, record.run]); groups.set(key, [...groups.get(key) ?? [], record]); }
  const chosen = new Set<string>(), units = new Map<string, number>();
  let checkedNumericCells = 0, checkedQuantityCells = 0;
  for (const group of [...groups.values()].sort((a, b) => b[0]!.runAt.localeCompare(a[0]!.runAt))) {
    const first = group[0]!, identity = JSON.stringify([first.sid, first.fba]);
    if (chosen.has(identity)) continue;
    try {
      const latest = (operation: Archived['operation'], offset = 0) => group.filter((record) => record.operation === operation && (operation !== 'list' || Number(record.params.offset) === offset)).sort((a, b) => b.attempt - a.attempt || b.file.localeCompare(a.file))[0];
      const listFirst = latest('list'), details = latest('details'), packing = latest('packing');
      assert(listFirst && details && packing, 'Incomplete list/details/packing in the same archive run');
      const listFiles: Archived[] = [];
      const listingResult = await fetchCompleteShipmentList(async (params) => {
        const page = latest('list', params.offset); assert(page, 'Missing archived list page');
        assert.equal(Number(page.params.length), params.length); assert.equal(page.params.start_date, listFirst.params.start_date); assert.equal(page.params.end_date, listFirst.params.end_date); listFiles.push(page); return page.response;
      }, 100);
      const matches = listingResult.rows.filter((row) => String(row.sid) === String(first.sid) && String(row.shipment_id).trim().toUpperCase() === first.fba);
      assert.equal(matches.length, 1, 'List sid/FBA must match exactly once');
      const listing = matches[0]!, selectedFiles = [...listFiles, details, packing], demandId = randomUUID(), groupId = randomUUID(), m2ConfirmationId = randomUUID(), at = new Date().toISOString();
      const shipment = normalizeShipment({ sid: first.sid, fba: first.fba, listing, details: details.response, packing: packing.response, observedAt: first.runAt });
      assert.deepEqual(validateShipmentData(shipment).filter((issue) => issue.severity === 'error'), [], 'Archived M2 technical box structure must be complete');
      const snapshotIds = selectedFiles.map(() => randomUUID());
      const revision = { id: randomUUID(), demandId, version: 1, demandVersion: 1, data: shipment, source: 'lingxing' as const, snapshotIds, reason: technicalLabel, createdBy: technicalLabel, createdAt: at };
      const member: GroupConfirmation['snapshot']['members'][number] = { id: demandId, snapshot: { sid: first.sid, fba: first.fba, shop: String(listing.seller ?? '归档来源'), country: String(object(listing.ship_to_address).country_code ?? '归档来源'), channel: null, destinationFc: String(listing.destination_fulfillment_center_id ?? ''), referenceQuantity: null, notes: technicalLabel, subBatchName: technicalLabel }, version: 1, businessDate: '2026-10-18', weekStartDate: '2026-10-12', weekEndDate: '2026-10-18', createdAt: at, updatedAt: at };
      const source = buildPhysicalSource({ id: randomUUID(), groupId, m2ConfirmationId, origin: 'history', createdBy: technicalLabel, createdAt: at, shipments: [{ demandId, revision }], members: [member], codes: shipment.boxes.map((box) => ({ id: randomUUID(), groupId, demandId, boxId: box.id, prefix: '技术复算', sequence: box.order!, code: `技术复算${box.order}`, valid: true, createdAt: at })), evidence: [{ demandId, listing, details: details.response, packing: packing.response, observedAt: first.runAt, snapshotIds }] });
      assert.equal(source.identityValid, true); assert.deepEqual(source.issues.filter((issue) => issue.severity === 'error'), []);
      for (const box of source.boxes) {
        const pair = `${box.raw.weightUnit}/${box.raw.dimensionUnit}`; units.set(pair, (units.get(pair) ?? 0) + 1);
        const factor = box.raw.weightUnit!.toUpperCase() === 'LB' ? '0.45359237' : '1', dimension = box.raw.dimensionUnit!.toUpperCase() === 'IN' ? '2.54' : '1';
        for (const field of ['weight', 'length', 'width', 'height'] as const) {
          const expected = new Decimal(box.raw[field]!).times(field === 'weight' ? factor : dimension).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
          assert.equal(box.values[field], expected); assert.match(box.values[field]!, /^\d+\.\d{2}$/); checkedNumericCells++;
        }
      }
      // These consistent flags are isolated generator fixtures only. No review,
      // confirmation or shipment is inserted into any database.
      confirmations.push({ id: randomUUID(), groupId, m2ConfirmationId, m3Version: 1, sourceFingerprint: source.fingerprint, snapshot: { source, entries: pendingEntries(source).map((entry) => ({ ...entry, status: 'consistent' })), ruleVersion: PHYSICAL_RULE_VERSION }, createdBy: technicalLabel, createdAt: at });
      selections.push({ sid: first.sid, fba: first.fba, run: relative(repo, first.run).replaceAll('\\', '/'), observedAt: first.runAt, files: selectedFiles.map((file) => ({ path: relative(repo, file.file).replaceAll('\\', '/'), sha256: file.sha256 })), boxes: source.boxes.length, itemRows: source.boxes.reduce((sum, box) => sum + box.items.length, 0), po: source.boxes[0]?.po ?? null });
      chosen.add(identity);
    } catch (error) { rejected.push({ sid: first.sid, fba: first.fba, run: relative(repo, first.run).replaceAll('\\', '/'), reason: error instanceof Error ? error.message : String(error) }); }
  }
  assert(confirmations.length > 0, 'At least one complete archived shipment is required');
  assert([...units.keys()].some((unit) => unit.toUpperCase() === 'LB/IN'), 'Real archived LB/IN coverage is required');
  const generated = await createPhysicalWorkbook(confirmations), workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(generated as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['实物箱明细', '箱内商品', '版本与核对记录']);
  const physical = workbook.getWorksheet('实物箱明细')!, itemSheet = workbook.getWorksheet('箱内商品')!;
  assert.equal(physical.rowCount - 1, selections.reduce((sum, entry) => sum + entry.boxes, 0)); assert.equal(itemSheet.rowCount - 1, selections.reduce((sum, entry) => sum + entry.itemRows, 0));
  let rowNumber = 2;
  for (const confirmation of confirmations) for (const box of confirmation.snapshot.source.boxes) {
    assert.equal(physical.getCell(rowNumber, 4).value, box.po); assert.equal(physical.getCell(rowNumber, 5).value, box.range);
    for (const [index, field] of (['weight', 'length', 'width', 'height'] as const).entries()) {
      const cell = physical.getCell(rowNumber, 9 + index); assert.equal(typeof cell.value, 'number'); assert.equal(cell.numFmt, '0.00'); assert.equal(new Decimal(String(cell.value)).toFixed(2), box.values[field]);
    }
    rowNumber++;
  }
  itemSheet.eachRow((row, index) => { if (index > 1) { assert.equal(typeof row.getCell(9).value, 'number'); checkedQuantityCells++; } });
  workbook.title = technicalLabel; workbook.subject = '归档数据纯函数技术复算；一致状态为生成器夹具，非现场核对或人工签收'; workbook.creator = technicalLabel; workbook.description = 'No database writes. No external requests. Not an operational confirmation.';
  await mkdir(output, { recursive: true }); const filename = `${technicalLabel}.xlsx`, xlsx = Buffer.from(await workbook.xlsx.writeBuffer()); await writeFile(resolve(output, filename), xlsx);
  for (const [file, sha256] of before) assert.equal(hash(await readFile(file)), sha256, `Original archive changed: ${file}`);
  const report = { format: 'm3-archive-recalculation/v1', result: 'passed', generatedAt: new Date().toISOString(), classification: 'technical-offline-recalculation-only', businessSignoff: 'pending-no-available-business-batch',
    explanation: '技术复算使用归档真实领星登记值；consistent仅为隔离文件生成器输入，不表示任何现场实物核对、数据库确认或业务签收。', externalRequests: 0, databaseWrites: 0,
    originalArchiveFiles: before.size, originalHashesUnchanged: true, archiveResponses: archived.length, selectedShipments: selections.length, selectedBoxes: rowNumber - 2, selectedBoxItemRows: checkedQuantityCells,
    checkedNormalizedStrings: checkedNumericCells, checkedXlsxNumericCells: checkedNumericCells, unitBoxCounts: Object.fromEntries(units), ruleVersion: PHYSICAL_RULE_VERSION,
    xlsx: { path: `.local/m3/${filename}`, sha256: hash(xlsx), bytes: xlsx.length, sheets: workbook.worksheets.map((sheet) => ({ name: sheet.name, rows: sheet.rowCount - 1 })) }, selections, rejectedIncompleteRuns: rejected, ignoredResponses: ignored };
  await writeFile(resolve(output, 'archive.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ result: report.result, selectedShipments: report.selectedShipments, selectedBoxes: report.selectedBoxes, selectedBoxItemRows: report.selectedBoxItemRows, unitBoxCounts: report.unitBoxCounts, originalHashesUnchanged: true, report: '.local/m3/archive.json', xlsx: report.xlsx.path, businessSignoff: report.businessSignoff }, null, 2));
} finally { globalThis.fetch = originalFetch; }
