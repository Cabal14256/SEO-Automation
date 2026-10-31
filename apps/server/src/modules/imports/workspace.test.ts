import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { demandWorkspaceQuerySchema, demandWorkspaceSchema, type DemandRecord, type GroupConfirmation, type ShipmentProduct, type ShipmentRevision, type WeeklyBatch } from '@scm/contracts';
import { hydrateDemandWorkspaceSources, projectDemandWorkspace, type DemandWorkspaceInput, type WorkspaceGroup } from './workspace-projection.js';

const at = '2026-10-17T01:00:00.000Z';
function demand(overrides: Partial<DemandRecord> = {}): DemandRecord {
  return { id: randomUUID(), snapshot: { sid: 101, fba: 'FBA12345', shop: '测试店铺', country: '美国', channel: 'HY', destinationFc: 'ONT8', referenceQuantity: '99', notes: null, subBatchName: null },
    version: 1, businessDate: '2026-09-05', weekStartDate: '2026-08-31', weekEndDate: '2026-09-06', createdAt: at, updatedAt: at, ...overrides };
}
function product(overrides: Partial<ShipmentProduct> = {}): ShipmentProduct {
  return { msku: 'MSKU-1', fnsku: 'FNSKU-1', sku: 'SKU-1', name: '测试商品', quantity: '5', ...overrides };
}
function revision(member: DemandRecord, overrides: Partial<ShipmentRevision> = {}): ShipmentRevision {
  const item = product();
  return { id: randomUUID(), demandId: member.id, version: 1, demandVersion: member.version, source: 'manual', snapshotIds: [], reason: '人工补录', createdBy: 'admin', createdAt: at,
    data: { sid: member.snapshot.sid, fba: member.snapshot.fba, items: [item], boxes: [{ id: randomUUID(), externalBoxId: null, packageId: null, localBoxId: null, name: null, order: 1, items: [item] }], observedAt: at, issues: [] }, ...overrides };
}
function fixture(member = demand(), ship?: ShipmentRevision) {
  const batch: WeeklyBatch = { id: randomUUID(), weekStartDate: member.weekStartDate, weekEndDate: member.weekEndDate, version: 1, sortMode: 'fba', nextPrefix: 0, createdAt: at };
  const group: WorkspaceGroup = { id: randomUUID(), batchId: batch.id, name: '9-A', version: 2, status: 'confirmed', confirmedVersion: 2, frozenAt: null, actualShipDate: '2026-09-06', updatedAt: at };
  const shipment = ship ?? revision(member);
  const confirmation: GroupConfirmation = { id: randomUUID(), groupId: group.id, groupVersion: 2, snapshot: { members: [structuredClone(member)], shipments: [{ demandId: member.id, revision: structuredClone(shipment) }], ruleVersion: 'shipment-detail-quantity-v1' }, createdBy: 'admin', createdAt: at };
  const input: DemandWorkspaceInput = { demands: [member], groups: [group], batches: [batch], members: [{ demandId: member.id, demandVersion: member.version, groupId: group.id, batchId: batch.id }], shipments: [shipment], confirmations: [confirmation], codes: [], decisions: [], sources: [] };
  input.shippingMemberships = [{ demandId: member.id, groupId: group.id, runId: randomUUID(), month: '2026-09', sequence: 1, numberingDate: '2026-09-05', ticketNumber: '20260905-1-US-1' }];
  return { member, shipment, group, batch, confirmation, input };
}
const query = (overrides: Record<string, unknown> = {}) => demandWorkspaceQuerySchema.parse(overrides);
const project = (input: DemandWorkspaceInput, overrides: Record<string, unknown> = {}) => demandWorkspaceSchema.parse(projectDemandWorkspace(input, query(overrides), at));

describe('demand workspace projection', () => {
  it('materializes measurements only for the selected page while retaining global box bounds', () => {
    const first = fixture(demand({ snapshot: { ...demand().snapshot, fba: 'FBA-A' } }));
    const second = fixture(demand({ snapshot: { ...demand().snapshot, fba: 'FBA-B' } }));
    first.group.frozenAt = at; second.group.frozenAt = at;
    const offPage = second.confirmation.snapshot.shipments[0]!.revision.data.boxes[0]!;
    Object.defineProperty(offPage, 'weight', { get: () => { throw new Error('off-page measurement was materialized'); } });
    second.input.codes = [{ id: randomUUID(), groupId: second.group.id, demandId: second.member.id, boxId: offPage.id, prefix: 'A', sequence: 37, code: 'A37', valid: true, createdAt: at }];
    const input: DemandWorkspaceInput = { demands: [first.member, second.member], groups: [first.group, second.group], batches: [first.batch, second.batch],
      members: [...first.input.members, ...second.input.members], shipments: [...first.input.shipments, ...second.input.shipments], confirmations: [first.confirmation, second.confirmation],
      codes: second.input.codes, decisions: [], sources: [], shippingMemberships: [...first.input.shippingMemberships!, ...second.input.shippingMemberships!] };
    const result = project(input, { pageBy: 'demand', pageSize: 1 });
    expect(result.rows.map((row) => row.demandId)).toEqual([first.member.id]);
    expect(result).toMatchObject({ demandTotal: 2, total: 2, maxBoxes: 37 });
  });

  it('hydrates page provenance with the same adopted-version and date precedence as full projection', () => {
    const f = fixture();
    f.input.sources = [
      { demandId: f.member.id, acceptedVersion: 1, importId: randomUUID(), fileName: 'first.xlsx', sheetName: 'Sheet1', rowNumber: 8, sourceFilledAt: '2026-09-01' },
      { demandId: f.member.id, acceptedVersion: 2, importId: randomUUID(), fileName: 'future.xlsx', sheetName: 'Sheet1', rowNumber: 9, sourceFilledAt: '2026-09-05' },
    ];
    const complete = projectDemandWorkspace(f.input, query({ pageBy: 'demand' }), at);
    const page = projectDemandWorkspace({ ...f.input, sources: [] }, query({ pageBy: 'demand' }), at);
    expect(hydrateDemandWorkspaceSources(page, f.input.sources)).toEqual(complete);
    expect(complete.rows[0]).toMatchObject({ sourceFilledAt: '2026-09-01', packingDays: 5, sources: [{ fileName: 'first.xlsx' }] });
  });

  it('uses the numbered occurrence month for a demand imported in a different month', () => {
    const f = fixture(demand({ businessDate: '2026-08-04', weekStartDate: '2026-08-03', weekEndDate: '2026-08-09' }));
    const occurrence = f.input.shippingMemberships![0]!;
    occurrence.month = '2026-10'; occurrence.sequence = 3; occurrence.numberingDate = '2026-10-24'; occurrence.ticketNumber = '20261024-3-US-1';
    const result = project(f.input, { month: '2026-10', shippingRunId: occurrence.runId });
    expect(result.rows[0]).toMatchObject({ businessDate: '2026-08-04', shippingMonth: '2026-10', shippingSequence: 3, ticketNumber: '20261024-3-US-1', monthQuantity: 5 });
    expect(project(f.input, { month: '2026-08' }).demandTotal).toBe(0);
    expect(project(f.input, { shippingRunId: randomUUID() }).demandTotal).toBe(0);
  });

  it('does not infer a shipment occurrence for an unassociated historical group', () => {
    const f = fixture(); f.input.shippingMemberships = [];
    expect(project(f.input).rows[0]).toMatchObject({ groupId: f.group.id, shippingRunId: null, shippingMonth: null, shippingSequence: null, ticketNumber: null });
    expect(project(f.input, { month: '2026-09' }).demandTotal).toBe(0);
    expect(project(f.input).filters.shippingRuns).toEqual([]);
  });

  it('totals the selected shipping month across separate occurrences while keeping each group total', () => {
    const first = fixture(), second = fixture(demand({ businessDate: '2026-08-01', snapshot: { ...first.member.snapshot, fba: 'FBANEXTMONTH' } }));
    for (const f of [first, second]) f.input.shippingMemberships![0]!.month = '2026-10';
    second.input.shippingMemberships![0]!.sequence = 2;
    second.shipment.data.items[0]!.quantity = '7'; second.shipment.data.boxes[0]!.items[0]!.quantity = '7'; second.confirmation.snapshot.shipments[0]!.revision = structuredClone(second.shipment);
    const input: DemandWorkspaceInput = { demands: [...first.input.demands, ...second.input.demands], groups: [...first.input.groups, ...second.input.groups], batches: [...first.input.batches, ...second.input.batches], members: [...first.input.members, ...second.input.members], shipments: [...first.input.shipments, ...second.input.shipments], confirmations: [...first.input.confirmations, ...second.input.confirmations], codes: [], decisions: [], sources: [], shippingMemberships: [...first.input.shippingMemberships!, ...second.input.shippingMemberships!] };
    const result = project(input, { month: '2026-10' });
    expect(result.rows.map((row) => row.monthQuantity)).toEqual([12, 12]);
    expect(result.rows.find((row) => row.demandId === first.member.id)?.groupQuantity).toBe(5);
    expect(result.rows.find((row) => row.demandId === second.member.id)?.groupQuantity).toBe(7);
  });

  it('filters lifecycle before pagination and retains cancelled demands only as read-only placeholders', () => {
    const f = fixture(), active = demand({ snapshot: { ...f.member.snapshot, fba: 'FBA00000' } });
    f.input.demands.push(active); f.input.cancelledDemandIds = [f.member.id];
    const current = project(f.input);
    expect(current).toMatchObject({ total: 1, demandTotal: 1 });
    expect(current.rows.map((row) => [row.demandId, row.lifecycle])).toEqual([[active.id, 'active']]);
    const history = project(f.input, { lifecycle: 'cancelled', pageBy: 'demand', pageSize: 1 });
    expect(history).toMatchObject({ total: 1, demandTotal: 1 });
    expect(history.rows[0]).toMatchObject({ demandId: f.member.id, lifecycle: 'cancelled', rowKind: 'placeholder', fba: f.member.snapshot.fba,
      groupId: null, confirmationId: null, dataRevisionId: null, quantity: null, totalBoxes: null, boxes: [], codes: [] });
    const all = project(f.input, { lifecycle: 'all', pageBy: 'demand', pageSize: 1, page: 2 });
    expect(all.demandTotal).toBe(2); expect(all.rows.map((row) => row.demandId)).toEqual([f.member.id]);
    expect(project(f.input, { lifecycle: 'cancelled', page: 2, pageSize: 1 }).rows).toEqual([]);
    const legacyRow = { ...current.rows[0] }; delete (legacyRow as Partial<typeof legacyRow>).lifecycle;
    expect(demandWorkspaceSchema.parse({ ...current, rows: [legacyRow] }).rows[0]!.lifecycle).toBe('active');
    expect(() => query({ lifecycle: 'deleted' })).toThrow();
  });
  it('keeps every unsynced demand as a nullable placeholder, without assigning an occurrence from its import date', () => {
    const f = fixture();
    const another = demand({ businessDate: '2026-10-02', weekStartDate: '2026-09-28', weekEndDate: '2026-10-04' });
    f.input.demands.push(another); f.input.groups = []; f.input.members = []; f.input.shipments = []; f.input.confirmations = [];
    const result = project(f.input);
    expect(result).toMatchObject({ total: 2, demandTotal: 2, maxBoxes: 10, pageSize: 50 });
    expect(result.rows.find((row) => row.demandId === f.member.id)).toMatchObject({ rowKind: 'placeholder', status: 'unsynced', batchId: null, groupId: null, quantity: null, totalBoxes: null, dataVersion: null, referenceQuantity: '99' });
    expect(result.rows.find((row) => row.demandId === another.id)?.batchId).toBeNull();
  });

  it('shows an effective confirmation before any allocation codes exist', () => {
    const f = fixture();
    const result = project(f.input);
    expect(result.rows[0]).toMatchObject({ status: 'confirmed', quantity: 5, groupQuantity: 5, monthQuantity: 5, confirmationId: f.confirmation.id, totalBoxes: 1, boxes: [{ quantity: 5, code: null }], codes: [] });
  });

  it('aligns local boxes 1 and 2 with their G7/G8 display columns while preserving actual box counts', () => {
    const f = fixture();
    f.shipment.data.items[0]!.quantity = '8';
    f.shipment.data.boxes[0]!.items = [product({ quantity: '3' })];
    f.shipment.data.boxes.push({ ...f.shipment.data.boxes[0]!, id: randomUUID(), order: 2, items: [product({ quantity: '5' })] });
    f.confirmation.snapshot.shipments[0]!.revision = structuredClone(f.shipment);
    f.input.codes = f.shipment.data.boxes.map((box, index) => ({ id: randomUUID(), groupId: f.group.id, demandId: f.member.id, boxId: box.id,
      prefix: 'G', sequence: index + 7, code: `G${index + 7}`, valid: true, createdAt: at }));
    const result = projectDemandWorkspace(f.input, query(), at);
    expect(result).toMatchObject({ maxBoxes: 10, rows: [{ status: 'confirmed', totalBoxes: 2, quantity: 8, boxes: [
      { boxOrder: 1, displayBoxOrder: 7, code: 'G7', quantity: 3 }, { boxOrder: 2, displayBoxOrder: 8, code: 'G8', quantity: 5 },
    ] }] });
    expect(result.rows[0]!.boxes.map((box) => box.boxId)).toEqual(f.shipment.data.boxes.map((box) => box.id));
  });

  it('keeps allocation gaps and computes display column 12 across the whole matching scope before pagination', () => {
    const f = fixture();
    f.shipment.data.items[0]!.quantity = '10';
    f.shipment.data.boxes[0]!.items = [product()];
    f.shipment.data.boxes.push({ ...f.shipment.data.boxes[0]!, id: randomUUID(), order: 2, items: [product()] });
    f.confirmation.snapshot.shipments[0]!.revision = structuredClone(f.shipment);
    const firstBox = f.shipment.data.boxes[0]!, secondBox = f.shipment.data.boxes[1]!;
    f.input.codes = [
      { id: randomUUID(), groupId: f.group.id, demandId: f.member.id, boxId: firstBox.id, prefix: 'G', sequence: 7, code: 'G7', valid: true, createdAt: at },
      { id: randomUUID(), groupId: f.group.id, demandId: f.member.id, boxId: secondBox.id, prefix: 'G', sequence: 12, code: 'G12', valid: true, createdAt: at },
      { id: randomUUID(), groupId: f.group.id, demandId: f.member.id, boxId: secondBox.id, prefix: 'G', sequence: 8, code: 'G8', valid: false, createdAt: at },
    ];
    const earlier = demand({ snapshot: { ...f.member.snapshot, fba: 'FBA00000' } });
    f.input.demands.push(earlier); f.input.shipments.push(revision(earlier));
    const firstPage = projectDemandWorkspace(f.input, query({ pageSize: 1 }), at);
    const secondPage = projectDemandWorkspace(f.input, query({ pageSize: 1, page: 2 }), at);
    expect(firstPage).toMatchObject({ maxBoxes: 12, total: 2, demandTotal: 2 });
    expect(firstPage.rows[0]!.demandId).toBe(earlier.id);
    expect(secondPage).toMatchObject({ maxBoxes: 12, rows: [{ totalBoxes: 2, boxes: [
      { boxOrder: 1, displayBoxOrder: 7, code: 'G7' }, { boxOrder: 2, displayBoxOrder: 12, code: 'G12' },
    ], codes: ['G7', 'G12'] }] });
    expect(projectDemandWorkspace(f.input, query({ q: 'FBA00000' }), at).maxBoxes).toBe(10);
  });

  it('ignores invalid or foreign allocation identities and leaves unencoded candidates on their local columns', () => {
    const f = fixture(); f.input.confirmations = []; f.group.status = 'draft'; f.group.confirmedVersion = null;
    f.shipment.data.items[0]!.quantity = '10';
    f.shipment.data.boxes[0]!.items = [product()];
    f.shipment.data.boxes.push({ ...f.shipment.data.boxes[0]!, id: randomUUID(), order: 2, items: [product()] });
    const boxId = f.shipment.data.boxes[0]!.id;
    const code = { id: randomUUID(), groupId: f.group.id, demandId: f.member.id, boxId, prefix: 'G', sequence: 99, code: 'G99', valid: false, createdAt: at };
    f.input.codes = [code, { ...code, id: randomUUID(), valid: true, demandId: randomUUID() }, { ...code, id: randomUUID(), valid: true, groupId: randomUUID() },
      { ...code, id: randomUUID(), valid: true, boxId: randomUUID() }];
    const result = projectDemandWorkspace(f.input, query(), at);
    expect(result).toMatchObject({ maxBoxes: 10, rows: [{ status: 'candidate', totalBoxes: 2, confirmationId: null,
      boxes: [{ boxOrder: 1, code: null, quantity: 5 }, { boxOrder: 2, code: null, quantity: 5 }], codes: [] }] });
    expect(result.rows[0]!.boxes.every((box) => !Object.hasOwn(box, 'displayBoxOrder'))).toBe(true);
  });

  it('does not present an old confirmation after a newer candidate or demand version appears', () => {
    const f = fixture();
    const newer = revision(f.member, { version: 2 });
    newer.data.items[0]!.quantity = '6'; newer.data.boxes[0]!.items[0]!.quantity = '6';
    f.input.shipments.push(newer);
    expect(project(f.input).rows[0]).toMatchObject({ status: 'needs_review', quantity: 6, groupQuantity: null, monthQuantity: null, confirmationId: null, dataRevisionId: newer.id });
    f.input.demands[0] = { ...f.member, version: 2 };
    expect(project(f.input).rows[0]!.issues.map((issue) => issue.code)).toContain('DEMAND_VERSION_STALE');
  });

  it('freezes both demand metadata and product data despite newer live demand/candidate versions', () => {
    const f = fixture();
    f.group.status = 'frozen'; f.group.frozenAt = at;
    f.confirmation.snapshot.shipments[0]!.revision.data.boxes[0]!.weight = '12.50';
    f.confirmation.snapshot.shipments[0]!.revision.data.boxes[0]!.weightUnit = 'LB';
    f.input.demands[0] = { ...f.member, version: 2, snapshot: { ...f.member.snapshot, shop: '更名后', destinationFc: 'NEW1', country: '英国' } };
    const newer = revision(f.input.demands[0], { version: 2 }); newer.data.items[0]!.quantity = '30';
    newer.data.boxes[0]!.weight = '99';
    f.input.shipments.push(newer);
    expect(project(f.input, { region: 'US' }).rows[0]).toMatchObject({ status: 'frozen', shop: '测试店铺', destinationFc: 'ONT8', quantity: 5, groupQuantity: 5, monthQuantity: 5,
      boxes: [{ weight: 12.5, weightUnit: 'LB' }], demandVersion: 1, currentDemandVersion: 2, dataRevisionId: f.shipment.id, confirmationId: f.confirmation.id });
    expect(project(f.input, { region: 'EU' }).total).toBe(0);
  });

  it.each(['SHIPPED', 'RECEIVING', null, undefined])('immediately hides historical receipt warnings for frozen status %s without revalidating or changing the snapshot', (shipmentStatus) => {
    const f = fixture(); f.group.status = 'frozen'; f.group.frozenAt = at;
    const data = f.confirmation.snapshot.shipments[0]!.revision.data;
    data.shipmentStatus = shipmentStatus; data.items[0]!.receivedQuantity = '0';
    // Frozen display must keep its accepted facts and unrelated original issues;
    // a receipt-display change must not introduce new product validation errors.
    data.items[0]!.name = null;
    data.issues = [
      { code: 'RECEIPT_DIFFERENCE', severity: 'warning', message: 'old receipt difference' },
      { code: 'RECEIVED_DIFFERENCE', severity: 'warning', message: 'old duplicate receipt difference' },
      { code: 'SOURCE_NOTE', severity: 'warning', message: 'keep the original unrelated note' },
    ];
    const newer = revision(f.member, { version: 2 }); newer.data.shipmentStatus = 'CLOSED'; newer.data.items[0]!.receivedQuantity = '4';
    f.input.shipments.push(newer);
    const before = structuredClone(f.input), row = project(f.input).rows[0]!;
    expect(row).toMatchObject({ status: 'frozen', quantity: 5, groupQuantity: 5, monthQuantity: 5, dataRevisionId: f.shipment.id,
      issues: [{ code: 'SOURCE_NOTE', message: 'keep the original unrelated note' }] });
    expect(f.input).toEqual(before);
  });

  it.each(['4', '6'])('shows one current receipt warning for a closed frozen shipment received as %s while preserving actual quantities', (receivedQuantity) => {
    const f = fixture(); f.group.status = 'frozen'; f.group.frozenAt = at;
    const data = f.confirmation.snapshot.shipments[0]!.revision.data;
    data.shipmentStatus = 'CLOSED'; data.items[0]!.receivedQuantity = receivedQuantity;
    data.issues = [
      { code: 'RECEIPT_DIFFERENCE', severity: 'warning', message: 'old receipt difference' },
      { code: 'RECEIVED_DIFFERENCE', severity: 'warning', message: 'old duplicate receipt difference' },
    ];
    const before = structuredClone(f.input), row = project(f.input).rows[0]!;
    expect(row).toMatchObject({ status: 'frozen', quantity: 5, groupQuantity: 5, monthQuantity: 5, boxes: [{ quantity: 5 }] });
    expect(row.issues).toEqual([expect.objectContaining({ code: 'RECEIVED_DIFFERENCE', severity: 'warning' })]);
    expect(f.input).toEqual(before);
  });

  it('removes stale raw receipt warnings when a frozen closed shipment has matching received quantities', () => {
    const f = fixture(); f.group.status = 'frozen'; f.group.frozenAt = at;
    const data = f.confirmation.snapshot.shipments[0]!.revision.data;
    data.shipmentStatus = 'CLOSED'; data.items[0]!.receivedQuantity = '5';
    data.issues = [{ code: 'RECEIPT_DIFFERENCE', severity: 'warning', message: 'old receipt difference' }];
    const before = structuredClone(f.input);
    expect(project(f.input).rows[0]).toMatchObject({ status: 'frozen', quantity: 5, issues: [] });
    expect(f.input).toEqual(before);
  });

  it.each(['RECEIVING', 'CLOSED'])('uses the same receipt stage rule for candidate status %s', (shipmentStatus) => {
    const f = fixture(); f.input.confirmations = []; f.group.status = 'draft'; f.group.confirmedVersion = null;
    f.shipment.data.shipmentStatus = shipmentStatus; f.shipment.data.items[0]!.receivedQuantity = '4';
    f.shipment.data.issues = [
      { code: 'RECEIPT_DIFFERENCE', severity: 'warning', message: 'old receipt difference' },
      { code: 'RECEIVED_DIFFERENCE', severity: 'warning', message: 'old duplicate receipt difference' },
    ];
    const before = structuredClone(f.input), row = project(f.input).rows[0]!;
    expect(row).toMatchObject({ status: 'candidate', quantity: 5, boxes: [{ quantity: 5 }] });
    expect(row.issues).toEqual(shipmentStatus === 'CLOSED' ? [expect.objectContaining({ code: 'RECEIVED_DIFFERENCE', severity: 'warning' })] : []);
    expect(f.input).toEqual(before);
  });

  it.each([
    ['WORKING', '0', false], ['RECEIVING', '2', false], ['CLOSED', '4', true], ['CLOSED', '6', true], ['CLOSED', '5', false],
  ])('uses latest Lingxing receiving progress %s/%s against frozen preparation quantities', (shipmentStatus, receivedQuantity, warned) => {
    const f = fixture(); f.group.status = 'frozen'; f.group.frozenAt = at;
    const accepted = f.confirmation.snapshot.shipments[0]!.revision;
    accepted.data.shipmentStatus = 'WORKING'; accepted.data.items[0]!.receivedQuantity = '0';
    accepted.data.issues = [{ code: 'SOURCE_NOTE', severity: 'warning', message: 'keep accepted source note' }];
    const latest = revision(f.member, { version: 2, source: 'lingxing' });
    latest.data.shipmentStatus = shipmentStatus as string; latest.data.items[0]!.receivedQuantity = receivedQuantity as string;
    // A later candidate's preparation quantity must never become the baseline.
    latest.data.items[0]!.quantity = '99';
    f.input.shipments.push(latest);
    const before = structuredClone(f.input), row = project(f.input).rows[0]!;
    expect(row).toMatchObject({ status: 'frozen', quantity: 5, groupQuantity: 5, monthQuantity: 5, boxes: [{ quantity: 5 }],
      dataRevisionId: accepted.id, dataVersion: accepted.version, confirmationId: f.confirmation.id });
    expect(row.issues.filter((issue) => issue.code === 'SOURCE_NOTE')).toEqual(accepted.data.issues);
    const receiptWarnings = row.issues.filter((issue) => issue.code === 'RECEIVED_DIFFERENCE');
    expect(receiptWarnings).toEqual(warned ? [expect.objectContaining({ severity: 'warning', details: expect.objectContaining({ detail: '5', received: receivedQuantity }) })] : []);
    expect(f.input).toEqual(before);
  });

  it.each(['sid', 'fba'])('ignores latest Lingxing receipt progress with a different %s', (field) => {
    const f = fixture(); f.group.status = 'frozen'; f.group.frozenAt = at;
    f.confirmation.snapshot.shipments[0]!.revision.data.shipmentStatus = 'WORKING';
    const latest = revision(f.member, { version: 2, source: 'lingxing' });
    latest.data.shipmentStatus = 'CLOSED'; latest.data.items[0]!.receivedQuantity = '4';
    if (field === 'sid') latest.data.sid++;
    else latest.data.fba = 'FBA-OTHER';
    f.input.shipments.push(latest);
    const before = structuredClone(f.input);
    expect(project(f.input).rows[0]).toMatchObject({ status: 'frozen', quantity: 5, issues: [] });
    expect(f.input).toEqual(before);
  });

  it.each(['duplicate', 'msku', 'fnsku', 'sku', 'incomplete'])('does not guess received quantities for %s latest product identities', (mismatch) => {
    const f = fixture(); f.group.status = 'frozen'; f.group.frozenAt = at;
    const accepted = f.confirmation.snapshot.shipments[0]!.revision;
    accepted.data.shipmentStatus = 'WORKING'; accepted.data.items[0]!.receivedQuantity = '0';
    const latest = revision(f.member, { version: 2, source: 'lingxing' });
    latest.data.shipmentStatus = 'CLOSED'; latest.data.items[0]!.receivedQuantity = '4';
    if (mismatch === 'duplicate') latest.data.items.push(structuredClone(latest.data.items[0]!));
    else if (mismatch === 'incomplete') latest.data.items[0]!.fnsku = '';
    else latest.data.items[0]![mismatch as 'msku' | 'fnsku' | 'sku'] = 'DIFFERENT';
    f.input.shipments.push(latest);
    const before = structuredClone(f.input);
    expect(project(f.input).rows[0]).toMatchObject({ status: 'frozen', quantity: 5, issues: [] });
    expect(f.input).toEqual(before);
  });

  it.each(['manual', 'xlsx'] as const)('retains frozen receipt facts when the latest overall candidate came from %s', (source) => {
    const f = fixture(); f.group.status = 'frozen'; f.group.frozenAt = at;
    const accepted = f.confirmation.snapshot.shipments[0]!.revision;
    accepted.data.shipmentStatus = 'CLOSED'; accepted.data.items[0]!.receivedQuantity = '4';
    const latest = revision(f.member, { version: 2, source });
    latest.data.shipmentStatus = 'RECEIVING'; latest.data.items[0]!.receivedQuantity = '5';
    f.input.shipments.push(latest);
    const before = structuredClone(f.input), row = project(f.input).rows[0]!;
    expect(row).toMatchObject({ status: 'frozen', quantity: 5, dataRevisionId: accepted.id,
      issues: [expect.objectContaining({ code: 'RECEIVED_DIFFERENCE', details: expect.objectContaining({ detail: '5', received: '4' }) })] });
    expect(f.input).toEqual(before);
  });

  it('does not use Lingxing progress from an earlier revision than the accepted frozen snapshot', () => {
    const f = fixture(); f.group.status = 'frozen'; f.group.frozenAt = at;
    const accepted = f.confirmation.snapshot.shipments[0]!.revision;
    accepted.version = 3; accepted.data.shipmentStatus = 'WORKING'; accepted.data.items[0]!.receivedQuantity = '0';
    const latest = revision(f.member, { version: 2, source: 'lingxing' });
    latest.data.shipmentStatus = 'CLOSED'; latest.data.items[0]!.receivedQuantity = '4';
    f.input.shipments = [latest];
    const before = structuredClone(f.input);
    expect(project(f.input).rows[0]).toMatchObject({ status: 'frozen', quantity: 5, dataRevisionId: accepted.id, dataVersion: 3, issues: [] });
    expect(f.input).toEqual(before);
  });

  it('invalidates the entire confirmation when any member has changed', () => {
    const f = fixture();
    const another = demand();
    f.input.demands.push(another); f.input.members.push({ demandId: another.id, demandVersion: 1, groupId: f.group.id, batchId: f.batch.id });
    expect(project(f.input).rows.every((row) => row.confirmationId === null)).toBe(true);
    expect(project(f.input).rows.find((row) => row.demandId === f.member.id)?.status).toBe('needs_review');
  });

  it('preserves invalid and missing quantities as null while retaining a real zero and duplicate product rows', () => {
    const f = fixture(); f.input.confirmations = []; f.group.status = 'draft'; f.group.confirmedVersion = null;
    f.shipment.data.items = [product({ quantity: 'bad' }), product({ quantity: null }), product({ quantity: '0' }), product({ quantity: '0' })];
    f.shipment.data.boxes[0]!.items[0]!.quantity = null;
    const result = project(f.input);
    expect(result.total).toBe(4); expect(new Set(result.rows.map((row) => row.id)).size).toBe(4);
    expect(result.rows.map((row) => row.quantity)).toEqual([null, null, 0, 0]);
    expect(result.rows[0]!.boxes[0]!.quantity).toBeNull();
    expect(result.rows[0]!.issues).toContainEqual(expect.objectContaining({ code: 'WORKSPACE_QUANTITY_UNAVAILABLE', details: expect.objectContaining({ value: 'bad' }) }));
  });

  it('filters the full expanded range before pagination and calculates box columns across all matching rows', () => {
    const f = fixture(); f.input.confirmations = []; f.group.status = 'draft'; f.group.confirmedVersion = null;
    const second = demand({ snapshot: { ...f.member.snapshot, fba: 'FBA99999' } }); const large = revision(second);
    large.data.boxes = Array.from({ length: 12 }, (_, index) => ({ ...large.data.boxes[0]!, id: randomUUID(), order: index + 1 }));
    f.input.demands.push(second); f.input.shipments.push(large);
    f.input.members.push({ demandId: second.id, demandVersion: second.version, groupId: f.group.id, batchId: f.batch.id });
    f.input.shippingMemberships!.push({ ...f.input.shippingMemberships![0]!, demandId: second.id });
    const firstPage = project(f.input, { month: '2026-09', sid: 101, country: '美国', channel: 'HY', pageSize: 1 });
    const secondPage = project(f.input, { month: '2026-09', sid: 101, country: '美国', channel: 'HY', pageSize: 1, page: 2 });
    expect(firstPage).toMatchObject({ total: 2, demandTotal: 2, maxBoxes: 12 });
    expect(secondPage).toMatchObject({ total: 2, demandTotal: 2, maxBoxes: 12 });
    expect(firstPage.rows[0]!.id).not.toBe(secondPage.rows[0]!.id);
    expect(project(f.input, { q: 'fba999', batchId: f.batch.id }).rows[0]!.demandId).toBe(second.id);
    expect(project(f.input, { month: '2026-10' })).toMatchObject({ total: 0, demandTotal: 0, maxBoxes: 10 });
  });

  it('uses source dates without treating import business dates or updatedAt as shipment/form filling time', () => {
    const f = fixture();
    f.input.sources.push({ demandId: f.member.id, acceptedVersion: 1, importId: randomUUID(), fileName: '来源.xlsx', sheetName: '需求', rowNumber: 2, sourceFilledAt: '2026-09-01' });
    f.input.sources.push({ demandId: f.member.id, acceptedVersion: 2, importId: randomUUID(), fileName: '未来版本.xlsx', sheetName: '需求', rowNumber: 3, sourceFilledAt: '2026-09-04' });
    expect(project(f.input).rows[0]).toMatchObject({ sourceFilledAt: '2026-09-01', shipmentCreatedAt: null, packingDays: 5, sources: [{ fileName: '来源.xlsx' }] });
    f.input.sources = [];
    expect(project(f.input).rows[0]).toMatchObject({ sourceFilledAt: null, shipmentCreatedAt: null, packingDays: null });
  });

  it('keeps unarranged demands independent of shipping-month filters', () => {
    const f = fixture();
    const pending = demand({ weekStartDate: '2026-10-12', weekEndDate: '2026-10-18', businessDate: '2026-10-17' });
    f.input.demands.push(pending);
    expect(project(f.input, { grouping: 'ungrouped' }).rows.map((row) => row.demandId)).toEqual([pending.id]);
    expect(project(f.input, { groupId: f.group.id }).rows.every((row) => row.groupId === f.group.id)).toBe(true);
    const result = project(f.input, { grouping: 'ungrouped', month: '2026-09', shippingRunId: f.input.shippingMemberships![0]!.runId });
    expect(result.demandTotal).toBe(1);
    expect(result.filters.weeks).toEqual([]);
    expect(result.filters.shippingRuns[0]).toMatchObject({ month: '2026-09', sequence: 1 });
    expect(result.rows[0]!.demandId).toBe(pending.id);
  });

  it('pages complete shipments so product expansion never splits one selectable demand', () => {
    const f = fixture();
    f.group.status = 'draft'; f.input.confirmations = [];
    f.shipment.data.items = [product(), product({ msku: 'MSKU-2' }), product({ msku: 'MSKU-3' })];
    const other = demand({ snapshot: { ...f.member.snapshot, fba: 'FBA99999' } });
    f.input.demands.push(other);
    const first = project(f.input, { pageBy: 'demand', pageSize: 1 });
    const second = project(f.input, { pageBy: 'demand', pageSize: 1, page: 2 });
    expect(first).toMatchObject({ total: 4, demandTotal: 2 });
    expect(first.rows).toHaveLength(3);
    expect(new Set(first.rows.map((row) => row.demandId))).toEqual(new Set([f.member.id]));
    expect(second.rows.map((row) => row.demandId)).toEqual([other.id]);
    const searched = project(f.input, { pageBy: 'demand', q: 'MSKU-2' });
    expect(searched).toMatchObject({ total: 3, demandTotal: 1 });
    expect(searched.rows).toHaveLength(3);
  });

  it('finds a valid internal box code and keeps its complete demand without matching another demand\'s invalid code', () => {
    const f = fixture();
    f.group.status = 'draft'; f.group.confirmedVersion = null; f.input.confirmations = [];
    const secondProduct = product({ msku: 'MSKU-2', fnsku: 'FNSKU-2', sku: 'SKU-2' });
    f.shipment.data.items.push(secondProduct);
    f.shipment.data.boxes.push({ ...f.shipment.data.boxes[0]!, id: randomUUID(), order: 2, items: [secondProduct] });
    const other = demand({ snapshot: { ...f.member.snapshot, fba: 'FBA99999' } });
    const otherShipment = revision(other);
    f.input.demands.push(other); f.input.shipments.push(otherShipment);
    f.input.members.push({ demandId: other.id, demandVersion: other.version, groupId: f.group.id, batchId: f.batch.id });
    f.input.codes.push(
      { id: randomUUID(), groupId: f.group.id, demandId: f.member.id, boxId: f.shipment.data.boxes[0]!.id, prefix: 'A', sequence: 1, code: 'INTERNAL-TARGET-01', valid: true, createdAt: at },
      { id: randomUUID(), groupId: f.group.id, demandId: other.id, boxId: otherShipment.data.boxes[0]!.id, prefix: 'A', sequence: 2, code: 'INTERNAL-TARGET-01', valid: false, createdAt: at },
      { id: randomUUID(), groupId: f.group.id, demandId: other.id, boxId: otherShipment.data.boxes[0]!.id, prefix: 'A', sequence: 3, code: 'INTERNAL-OTHER-03', valid: true, createdAt: at },
    );
    const result = project(f.input, { pageBy: 'demand', pageSize: 1, q: '  internal-target-01  ' });
    expect(result).toMatchObject({ total: 2, demandTotal: 1 });
    expect(result.rows.map((row) => row.msku)).toEqual(['MSKU-1', 'MSKU-2']);
    expect(new Set(result.rows.map((row) => row.demandId))).toEqual(new Set([f.member.id]));
    expect(result.rows[0]!.codes).toEqual(['INTERNAL-TARGET-01']);
    expect(result.rows[1]!.codes).toEqual([]);
  });

  it('resolves only the existing version-bound quantity decision and supports status filters', () => {
    const f = fixture(); f.input.confirmations = []; f.group.status = 'draft'; f.group.confirmedVersion = null;
    f.shipment.data.items[0]!.listQuantity = '6';
    expect(project(f.input, { status: 'needs_review' }).total).toBe(1);
    f.input.decisions.push({ groupId: f.group.id, demandId: f.member.id, shipmentVersion: 1, issueCode: 'LIST_QUANTITY_MISMATCH' });
    expect(project(f.input, { status: 'candidate' }).total).toBe(1);
  });

  it('does not turn an impossible source date into a plausible packing duration', () => {
    const f = fixture();
    f.confirmation.snapshot.members[0]!.snapshot.sourceFilledAt = '2026-02-30';
    expect(project(f.input).rows[0]).toMatchObject({ sourceFilledAt: '2026-02-30', packingDays: null });
  });

  it('keeps mixed-product physical box identity and original measurement units in every product distribution', () => {
    const f = fixture();
    const mixedItem = product({ msku: 'MIXED-2', fnsku: 'FNSKU-2', sku: 'SKU-2', quantity: '3' });
    f.shipment.data.items.push(mixedItem);
    const box = f.shipment.data.boxes[0]!;
    box.items.push(mixedItem);
    Object.assign(box, { name: '混装箱', externalBoxId: 'EXT-1', localBoxId: 'LOCAL-1', weight: '12.50', weightUnit: 'LB', length: '22.40', width: '0', height: null, dimensionUnit: 'IN' });
    f.confirmation.snapshot.shipments[0]!.revision = structuredClone(f.shipment);
    const result = project(f.input);
    expect(result.total).toBe(2);
    expect(result.rows.every((row) => row.status === 'confirmed' && row.totalBoxes === 1 && row.boxes.length === 1)).toBe(true);
    expect(new Set(result.rows.flatMap((row) => row.boxes.map((entry) => entry.boxId)))).toEqual(new Set([box.id]));
    expect(result.rows[0]!.boxes[0]).toMatchObject({ boxId: box.id, boxName: '混装箱', externalBoxId: 'EXT-1', localBoxId: 'LOCAL-1', weight: 12.5, weightUnit: 'LB', length: 22.4, width: 0, height: null, lengthUnit: 'IN' });
    expect(result.rows.map((row) => row.groupQuantity)).toEqual([5, 3]);
  });

  it('calculates full confirmed-group and monthly totals by complete product identity before search or pagination', () => {
    const f = fixture(demand({ businessDate: '2026-09-30', weekStartDate: '2026-09-28', weekEndDate: '2026-10-04' }));
    const similarItem = product({ fnsku: 'FNSKU-DIFFERENT', quantity: '2' });
    f.shipment.data.items.push(similarItem); f.shipment.data.boxes[0]!.items.push(similarItem);
    f.confirmation.snapshot.shipments[0]!.revision = structuredClone(f.shipment);
    const october = demand({ businessDate: '2026-10-01', weekStartDate: f.member.weekStartDate, weekEndDate: f.member.weekEndDate, snapshot: { ...f.member.snapshot, fba: 'FBA-OCTOBER' } });
    const octoberRevision = revision(october);
    octoberRevision.data.items[0]!.quantity = '7'; octoberRevision.data.boxes[0]!.items[0]!.quantity = '7';
    f.input.demands.push(october); f.input.shipments.push(octoberRevision);
    f.input.shippingMemberships!.push({ demandId: october.id, groupId: f.group.id, runId: randomUUID(), month: '2026-10', sequence: 1, numberingDate: '2026-10-05', ticketNumber: '20261005-1-US-1' });
    f.input.members.push({ demandId: october.id, demandVersion: 1, groupId: f.group.id, batchId: f.batch.id });
    f.confirmation.snapshot.members.push(structuredClone(october));
    f.confirmation.snapshot.shipments.push({ demandId: october.id, revision: structuredClone(octoberRevision) });
    const september = project(f.input, { month: '2026-09', q: 'FNSKU-1', pageSize: 1 });
    expect(september).toMatchObject({ total: 1, demandTotal: 1 });
    expect(september.rows[0]).toMatchObject({ quantity: 5, groupQuantity: 12, monthQuantity: 5 });
    expect(project(f.input, { month: '2026-10' }).rows[0]).toMatchObject({ quantity: 7, groupQuantity: 12, monthQuantity: 7 });
    const full = project(f.input);
    expect(full.rows.find((row) => row.fnsku === 'FNSKU-DIFFERENT')).toMatchObject({ groupQuantity: 2, monthQuantity: 2 });
    expect(full.rows.filter((row) => row.fnsku === 'FNSKU-1').every((row) => row.groupQuantity === 12 && row.monthQuantity === 12)).toBe(true);
    f.input.shipments.push(revision(october, { version: 2 }));
    expect(project(f.input).rows.every((row) => row.groupQuantity === null && row.monthQuantity === null)).toBe(true);
  });

  it('keeps candidate and placeholder totals empty and accepts legacy rows without the optional additions', () => {
    const f = fixture();
    f.input.confirmations = []; f.group.status = 'draft'; f.group.confirmedVersion = null;
    f.input.demands.push(demand({ snapshot: { ...f.member.snapshot, fba: 'FBA-UNSYNCED' } }));
    const result = project(f.input);
    expect(result.rows.every((row) => row.groupQuantity === null && row.monthQuantity === null)).toBe(true);
    const legacy = structuredClone(result);
    for (const row of legacy.rows) {
      delete row.groupQuantity; delete row.monthQuantity;
      for (const box of row.boxes) {
        delete box.boxName; delete box.externalBoxId; delete box.localBoxId; delete box.weight; delete box.weightUnit;
        delete box.length; delete box.width; delete box.height; delete box.lengthUnit;
      }
    }
    expect(demandWorkspaceSchema.safeParse(legacy).success).toBe(true);
  });

  it('filters region using the shared report country rules while preserving full filter options', () => {
    const f = fixture();
    const uk = demand({ snapshot: { ...f.member.snapshot, country: 'uk', fba: 'FBA-UK' } });
    const canada = demand({ snapshot: { ...f.member.snapshot, country: '加拿大', fba: 'FBA-CA' } });
    f.input.demands.push(uk, canada);
    expect(project(f.input, { region: 'EU', pageBy: 'demand' }).rows.map((row) => row.demandId)).toEqual([uk.id]);
    expect(project(f.input, { region: 'US' }).rows.map((row) => row.demandId)).toEqual([f.member.id]);
    expect(project(f.input, { region: 'all' }).demandTotal).toBe(3);
    expect(project(f.input, { region: 'EU' }).filters.countries).toEqual(expect.arrayContaining(['美国', 'uk', '加拿大']));
    expect(() => query({ region: 'APAC' })).toThrow();
  });
});
