import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { reportExportInputSchema, reportResponseSchema, type DemandRecord, type ShipmentRevision } from '@scm/contracts';

vi.mock('../../db/client.js', () => ({ db: {}, pool: {} }));
vi.mock('../imports/service.js', () => ({ checkedFileBytes: vi.fn() }));
vi.mock('../shipping-runs/service.js', () => ({ getReadyShippingRunInTx: vi.fn(), getShippingRunReportScopeInTx: vi.fn() }));
import { assertShippingRunProjection, projectConfirmedGroups, type ReportFilter, type ShippingReportScope } from './report-service.js';

type Confirmed = Parameters<typeof projectConfirmedGroups>[0][number];
const at = '2026-10-20T00:00:00.000Z';
function fixture({ name = '九月 Alpha 批次', products = 2, boxCount = 2 } = {}): Confirmed {
  const groupId = randomUUID();
  const member: DemandRecord = { id: randomUUID(), version: 1, businessDate: '2026-09-07', weekStartDate: '2026-09-07', weekEndDate: '2026-09-13', createdAt: at, updatedAt: at,
    snapshot: { sid: 11, shop: 'North 商店', country: '美国', channel: 'HY', fba: 'FBA-Alpha-111', destinationFc: 'IND9', referenceQuantity: null, notes: null, subBatchName: null } };
  const items = Array.from({ length: products }, (_, index) => ({ msku: `MSKU-Alpha-${index}`, fnsku: `FNSKU-Beta-${index}`, sku: `SKU-Gamma-${index}`, name: `Widget 商品 ${index}`, quantity: String(boxCount) }));
  const boxes = Array.from({ length: boxCount }, (_, index) => ({ id: randomUUID(), order: index + 1, name: `箱 ${index + 1}`, externalBoxId: null, localBoxId: null,
    weight: null, length: null, width: null, height: null, items: items.map((item) => ({ ...item, quantity: '1' })) }));
  const revision: ShipmentRevision = { id: randomUUID(), demandId: member.id, version: 1, demandVersion: 1, source: 'manual', snapshotIds: [], reason: '技术样本', createdBy: 'technical-admin', createdAt: at,
    data: { sid: member.snapshot.sid, fba: member.snapshot.fba, items, boxes, observedAt: at, issues: [] } };
  const members = [member], shipments = [{ demandId: member.id, revision }];
  return { group: { id: groupId, batchId: randomUUID(), name, version: 2, status: 'confirmed', position: 0, demandIds: [member.id], prefix: 'A', confirmedVersion: 2,
    frozenAt: null, correctionOfId: null, replacedById: null, actualShipDate: null, createdAt: at, updatedAt: at }, members, shipments,
    confirmation: { id: randomUUID(), groupId, groupVersion: 2, snapshot: { members, shipments, ruleVersion: 'test' }, createdBy: 'technical-admin', createdAt: at },
    codes: boxes.map((box, index) => ({ id: randomUUID(), groupId, demandId: member.id, boxId: box.id, prefix: 'A', sequence: index + 1, code: `CODE-Delta-${index + 1}`, valid: true, createdAt: at })) };
}
const project = (groups: Confirmed[], filter: ReportFilter = {}) => reportResponseSchema.parse(projectConfirmedGroups(groups, filter));

describe('shipment report search', () => {
  it('uses occurrence month rather than import month and does not infer unassigned history',()=>{
    const group=fixture(),member=group.confirmation.snapshot.members[0]!,runId=randomUUID();
    group.shippingDetails={[member.id]:{runId,month:'2026-10',sequence:3,ticketNumber:'20261024-3-US-1'}};
    expect(project([group],{month:'2026-10'}).rows).toHaveLength(2);
    expect(project([group],{month:'2026-10'}).rows[0]).toMatchObject({businessDate:'2026-09-07',shippingMonth:'2026-10',shippingRunSequence:3});
    expect(project([group],{month:'2026-09'}).rows).toHaveLength(0);
    group.shippingDetails={};
    expect(project([group],{month:'2026-09'}).rows).toHaveLength(0);
    expect(project([group]).rows).toHaveLength(2);
  });
  it('keeps a monthly business ticket and its product subtotal together across internal groups', () => {
    const one = fixture(), two = fixture(), shippingRunId = randomUUID(), ticketId = randomUUID();
    two.codes = two.codes.map((code, index) => ({ ...code, prefix: 'B', code: `B${index + 1}` }));
    one.codes = one.codes.map((code, index) => ({ ...code, prefix: 'A', code: `A${index + 1}` }));
    for (const [inputOrder, group] of [two, one].entries()) group.shippingDetails = { [group.members[0]!.id]: {
      runId: shippingRunId, month: '2026-10', sequence: 3, ticketId, ticketNumber: '20261024-3-US-1', sourceTicketIndex: 0, inputOrder,
    } };
    const first = project([one, two], { month: '2026-10', pageSize: 1 });
    expect(first.rows[0]).toMatchObject({ ticketId, demandId: two.members[0]!.id, inputOrder: 0, groupQuantity: 4, monthQuantity: 4, ticketCodeRange: 'A1-A2、B1-B2' });
    expect(first.boxes.every((box) => box.ticketId === ticketId && box.ticketNumber === '20261024-3-US-1')).toBe(true);
    const complete = project([one, two], { month: '2026-10', pageSize: 100 });
    expect(complete.rows.map((row) => row.groupId)).toEqual([two.group.id, two.group.id, one.group.id, one.group.id]);
    expect(complete.rows.every((row) => row.groupQuantity === 4 && row.monthQuantity === 4)).toBe(true);
  });
  it.each(['alpha 批次', 'fba-alpha', 'north', 'widget', 'msku-alpha-0', 'fnsku-beta-0', 'sku-gamma-0', 'code-delta-2'])('finds %s case-insensitively and retains the complete matching sub-batch', (q) => {
    const group = fixture();
    const result = project([group], { q: `  ${q.toUpperCase()}  ` });
    expect(result).toMatchObject({ total: 2, maxBoxes: 2, page: 1, pageSize: 50 });
    expect(result.rows).toHaveLength(2); expect(result.boxes).toHaveLength(2);
    expect(result.confirmations).toEqual([{ groupId: group.group.id, groupVersion: 2, confirmationId: group.confirmation.id }]);
  });

  it('filters complete projections before pagination and keeps off-page references and box metadata consistent', () => {
    const other = fixture({ name: '其他批次', products: 55, boxCount: 12 });
    const match = fixture({ name: 'Target 批次', products: 3 });
    const filter = { q: 'TARGET', pageSize: 2 };
    const first = project([other, match], filter), second = project([other, match], { ...filter, page: 2 });
    expect(first.rows).toHaveLength(2); expect(second.rows).toHaveLength(1);
    expect(first.total).toBe(3); expect(second.total).toBe(3);
    expect(new Set([...first.rows, ...second.rows].map((row) => row.id)).size).toBe(3);
    expect(first.maxBoxes).toBe(2); expect(first.boxes).toHaveLength(2);
    expect(first.confirmations).toEqual([{ groupId: match.group.id, groupVersion: 2, confirmationId: match.confirmation.id }]);
    expect(second.confirmations).toEqual(first.confirmations); expect(second.boxes).toEqual(first.boxes);
    expect(first.rows.every((row) => row.groupId === match.group.id)).toBe(true);
  });

  it('only searches shipments included by the applied month and region', () => {
    const group = fixture();
    for (const [name, businessDate, country] of [['OctoberOnly', '2026-10-01', '美国'], ['EuropeOnly', '2026-09-08', '英国']]) {
      const addition = fixture();
      const member = addition.members[0]!;
      member.businessDate = businessDate!; member.snapshot.country = country!; member.snapshot.shop = name!;
      group.members.push(member); group.group.demandIds.push(member.id); group.shipments.push(...addition.shipments);
      group.codes.push(...addition.codes.map((code) => ({ ...code, groupId: group.group.id })));
    }
    const filter = { month: '2026-09', region: 'US' as const };
    expect(project([group], { ...filter, q: 'OctoberOnly' }).total).toBe(0);
    expect(project([group], { ...filter, q: 'EuropeOnly' }).confirmations).toEqual([]);
    const result = project([group], { ...filter, q: 'north' });
    expect(result.total).toBe(2); expect(result.boxes).toHaveLength(2);
    expect(result.rows.every((row) => row.businessDate.startsWith('2026-09') && row.country === '美国')).toBe(true);
  });

  it('returns empty scope metadata for no matches and treats whitespace as an unfiltered search', () => {
    const groups = [fixture()];
    expect(project(groups, { q: 'not-found' })).toMatchObject({ rows: [], boxes: [], confirmations: [], total: 0, maxBoxes: 0 });
    const unfiltered = project(groups), whitespace = project(groups, { q: '   ' });
    expect(whitespace).toEqual({ ...unfiltered, generatedAt: whitespace.generatedAt });
  });
});

describe('shipment product box ordering', () => {
  function distributedFixture(distributions: Array<Array<[number, number]>>) {
    const boxCount = Math.max(1, ...distributions.flatMap((entries) => entries.map(([order]) => order)));
    const group = fixture({ products: distributions.length, boxCount });
    const data = group.confirmation.snapshot.shipments[0]!.revision.data;
    data.items = data.items.map((item, index) => ({ ...item, quantity: String(distributions[index]!.reduce((sum, [, quantity]) => sum + quantity, 0)) }));
    for (const box of data.boxes) box.items = data.items.flatMap((item, index) => distributions[index]!
      .filter(([order]) => order === box.order).map(([, quantity]) => ({ ...item, quantity: String(quantity) })));
    return group;
  }

  it('orders sparse and mixed-box products by descending quantity without changing accepted data', () => {
    const distributions: Array<Array<[number, number]>> = [[[6, 2]], [[4, 3]], [[1, 4], [2, 5], [6, 6]], [[5, 7]], [[3, 8]]];
    const group = distributedFixture(distributions), before = structuredClone(group);
    const result = project([group]);
    const data = group.confirmation.snapshot.shipments[0]!.revision.data;
    expect(result.rows.map((row) => row.sku)).toEqual([2, 4, 3, 1, 0].map((index) => data.items[index]!.sku));
    expect(result).toMatchObject({ total: 5, maxBoxes: 6 });
    for (const [index, item] of data.items.entries()) {
      const row = result.rows.find((entry) => entry.sku === item.sku)!;
      expect(row.quantity).toBe(Number(item.quantity));
      expect(row.groupQuantity).toBe(Number(item.quantity));
      expect(row.boxes.map((box) => [box.boxOrder, box.quantity])).toEqual(distributions[index]);
      expect(row.boxes.map((box) => box.boxId)).toEqual(distributions[index]!.map(([order]) => data.boxes[order - 1]!.id));
      expect(row.codes).toEqual(distributions[index]!.map(([order]) => `CODE-Delta-${order}`));
    }
    expect(result.rows[0]!.boxes.at(-1)!.boxId).toBe(result.rows.at(-1)!.boxes[0]!.boxId);
    expect(group).toEqual(before);
  });

  it('uses product quantity rather than the first occupied box for row order', () => {
    const group = distributedFixture([[[4, 1]], [[1, 1], [6, 2]], [[1, 2], [2, 3]], [[2, 4]]]);
    const result = project([group]);
    expect(result.rows.map((row) => row.sku)).toEqual([2, 3, 1, 0].map((index) => `SKU-Gamma-${index}`));
  });

  it('ignores zero quantities in the sort key and retains empty or all-zero products at the end', () => {
    const group = distributedFixture([[[1, 0], [5, 3]], [[3, 2]], [[1, 0]], []]);
    const result = project([group]);
    expect(result.rows.map((row) => row.sku)).toEqual([0, 1, 2, 3].map((index) => `SKU-Gamma-${index}`));
    expect(result.rows[0]!.boxes.map((box) => [box.boxOrder, box.quantity])).toEqual([[1, 0], [5, 3]]);
    expect(result.rows[2]).toMatchObject({ quantity: 0, boxes: [expect.objectContaining({ boxOrder: 1, quantity: 0 })] });
    expect(result.rows[3]).toMatchObject({ quantity: 0, boxes: [], codes: [] });
  });

  it('sorts before pagination and keeps real box columns beyond ten', () => {
    const group = distributedFixture([[[12, 1]], [[2, 2]], [[11, 3]], [[1, 4]]]);
    const first = project([group], { pageSize: 2 }), second = project([group], { pageSize: 2, page: 2 });
    expect(first.rows.map((row) => row.sku)).toEqual(['SKU-Gamma-3', 'SKU-Gamma-2']);
    expect(second.rows.map((row) => row.sku)).toEqual(['SKU-Gamma-1', 'SKU-Gamma-0']);
    expect(first.maxBoxes).toBe(12); expect(second.maxBoxes).toBe(12);
    expect(second.rows[1]!.boxes).toEqual([expect.objectContaining({ boxOrder: 12, quantity: 1 })]);
    expect(second.boxes).toEqual(first.boxes); expect(second.confirmations).toEqual(first.confirmations);
  });

  it('keeps FBA blocks and local box columns independent when product identities repeat across shipments', () => {
    const group = distributedFixture([[[3, 1]], [[1, 2]], [[2, 3]]]);
    const addition = distributedFixture([[[1, 4]], [[2, 5]]]);
    const member = addition.confirmation.snapshot.members[0]!;
    member.snapshot.fba = 'FBASECOND'; addition.confirmation.snapshot.shipments[0]!.revision.data.fba = member.snapshot.fba;
    group.confirmation.snapshot.members.push(member);
    group.confirmation.snapshot.shipments.push(...addition.confirmation.snapshot.shipments);
    group.group.demandIds.push(member.id);
    group.codes.push(...addition.codes.map((code) => ({ ...code, groupId: group.group.id })));
    const before = structuredClone(group), result = project([group]);
    expect(result.rows.map((row) => [row.fba, row.sku, row.boxes[0]!.boxOrder])).toEqual([
      ['FBASECOND', 'SKU-Gamma-1', 2], ['FBASECOND', 'SKU-Gamma-0', 1],
      ['FBA-Alpha-111', 'SKU-Gamma-1', 1], ['FBA-Alpha-111', 'SKU-Gamma-0', 3], ['FBA-Alpha-111', 'SKU-Gamma-2', 2],
    ]);
    expect(result.rows.filter((row) => row.sku === 'SKU-Gamma-0').map((row) => row.quantity)).toEqual([4, 1]);
    expect(result.rows.filter((row) => row.sku === 'SKU-Gamma-0').map((row) => row.groupQuantity)).toEqual([5, 5]);
    expect(group).toEqual(before);
  });

  it('retains ticket member input order across internal groups with one ticket-wide product order before pagination', () => {
    const one = distributedFixture([[[3, 1]], [[1, 2]], [[2, 3]]]), two = distributedFixture([[[2, 4]], [[1, 5]]]);
    const ticketId = randomUUID(), source = [one, two], before = structuredClone(source);
    const scope: ShippingReportScope = { shippingRunId: randomUUID(), version: 3, numberingDate: '2026-10-23', month: '2026-10', sequence: 2,
      members: source.map((group, index) => ({ demandId: group.members[0]!.id, groupId: group.group.id, ticketId,
        ticketNumber: '20261023-2-US-1', sourceTicketIndex: 0, inputOrder: index === 0 ? 2 : 1 })) };
    const result = projectConfirmedGroups(source, { pageSize: 3, month: '2026-10' }, scope);
    expect(result.rows.map((row) => [row.demandId, row.sku])).toEqual([
      [two.members[0]!.id, 'SKU-Gamma-1'], [two.members[0]!.id, 'SKU-Gamma-0'], [one.members[0]!.id, 'SKU-Gamma-1'],
    ]);
    expect(result.total).toBe(5); expect(result.confirmations).toHaveLength(2);
    const complete = projectConfirmedGroups(source, { pageSize: 100 }, scope);
    expect(complete.rows.map((row) => row.sku)).toEqual(['SKU-Gamma-1', 'SKU-Gamma-0', 'SKU-Gamma-1', 'SKU-Gamma-0', 'SKU-Gamma-2']);
    expect(complete.rows.filter((row) => row.sku === 'SKU-Gamma-0').map((row) => row.groupQuantity)).toEqual([5, 5]);
    assertShippingRunProjection(scope, complete);
    expect(source).toEqual(before);
  });
});

describe('allocation-backed report box columns', () => {
  function codedFixture(sequences: number[], prefix = 'G', products = 2) {
    const group = fixture({ products, boxCount: sequences.length });
    group.group.prefix = prefix;
    group.codes = group.codes.map((code, index) => ({ ...code, prefix, sequence: sequences[index]!, code: `${prefix}${sequences[index]}` }));
    return group;
  }
  function appendMember(target: Confirmed, sequences: number[], fba: string, products = 2) {
    const source = codedFixture(sequences, target.group.prefix ?? 'G', products), member = source.confirmation.snapshot.members[0]!;
    member.snapshot.fba = fba; source.confirmation.snapshot.shipments[0]!.revision.data.fba = fba;
    target.confirmation.snapshot.members.push(member); target.confirmation.snapshot.shipments.push(...source.confirmation.snapshot.shipments);
    target.group.demandIds.push(member.id); target.codes.push(...source.codes.map((code) => ({ ...code, groupId: target.group.id })));
    return member;
  }

  it('projects five fictional shipments as local box columns and one complete ten-box ticket', () => {
    const group = codedFixture([1, 2], 'A', 6), initial = group.members[0]!;
    initial.snapshot.fba = 'FBAREF-DELTA'; group.shipments[0]!.revision.data.fba = initial.snapshot.fba;
    const members = [initial, appendMember(group, [3], 'FBAREF-ALPHA', 6), appendMember(group, [4, 5], 'FBAREF-BRAVO', 6),
      appendMember(group, [6, 7, 8], 'FBAREF-ECHO', 6), appendMember(group, [9, 10], 'FBAREF-CHARLIE', 6)];
    for (const [index, member] of members.entries()) member.snapshot.destinationFc = `DEMO-${index + 1}`;
    const perBox = [['Demo-Paper', 9], ['Demo-Cable', 17], ['Demo-Adapter', 17], ['Demo-Stand', 29], ['Demo-Case', 83], ['Demo-Cap', 11]] as const;
    for (const shipment of group.shipments) {
      const data = shipment.revision.data;
      data.items = perBox.map(([name, quantity]) => ({ msku: name, fnsku: `FN-${name}`, sku: name, name, quantity: String(quantity * data.boxes.length) }));
      for (const box of data.boxes) box.items = perBox.map(([name, quantity]) => ({ msku: name, fnsku: `FN-${name}`, sku: name, quantity: String(quantity) }));
    }
    const inputOrder = new Map(['FBAREF-CHARLIE', 'FBAREF-ECHO', 'FBAREF-BRAVO', 'FBAREF-DELTA', 'FBAREF-ALPHA'].map((fba, index) => [fba, index]));
    const ticketId = randomUUID(), scope: ShippingReportScope = { shippingRunId: randomUUID(), version: 1, numberingDate: '2026-10-27', month: '2026-10', sequence: 1,
      members: members.map((member) => ({ demandId: member.id, groupId: group.group.id, ticketId, ticketNumber: '20261027-1-US-4', sourceTicketIndex: 3, inputOrder: inputOrder.get(member.snapshot.fba)! })) };
    const before = structuredClone(group), page = projectConfirmedGroups([group], { pageSize: 7 }, scope), complete = projectConfirmedGroups([group], { pageSize: 100 }, scope);
    expect(page).toMatchObject({ total: 30, maxBoxes: 3 });
    expect(page.rows.every((row) => row.ticketCodeRange === 'A1-A10')).toBe(true);
    expect(complete.rows.filter((_, index) => index % 6 === 0).map((row) => row.fba)).toEqual(['FBAREF-ALPHA', 'FBAREF-CHARLIE', 'FBAREF-BRAVO', 'FBAREF-DELTA', 'FBAREF-ECHO']);
    expect(complete.rows.slice(0, 6).map((row) => row.sku)).toEqual(['Demo-Case', 'Demo-Stand', 'Demo-Adapter', 'Demo-Cable', 'Demo-Cap', 'Demo-Paper']);
    expect(complete.rows.slice(0, 6).map((row) => row.groupQuantity)).toEqual([830, 290, 170, 170, 110, 90]);
    expect(complete.rows.filter((row) => row.sku === 'Demo-Case').map((row) => row.boxes.map((box) => [box.displayBoxOrder, box.quantity]))).toEqual([
      [[1, 83]], [[1, 83], [2, 83]], [[1, 83], [2, 83]], [[1, 83], [2, 83]], [[1, 83], [2, 83], [3, 83]],
    ]);
    expect(new Set(complete.boxes.map((box) => box.boxId)).size).toBe(10);
    expect(complete.rows.reduce((sum, row) => sum + row.quantity, 0)).toBe(1660);
    assertShippingRunProjection(scope, complete); expect(group).toEqual(before);
  });

  it('restarts display columns for each FBA while keeping all actual allocated codes and quantities', () => {
    const group = codedFixture([1, 2]);
    const members = [group.members[0]!, appendMember(group, [7, 8], 'FBAG007'), appendMember(group, [9, 10], 'FBAG009'), appendMember(group, [11, 12], 'FBAG011')];
    const before = structuredClone(group), report = project([group]);
    expect(report).toMatchObject({ total: 8, maxBoxes: 2 }); expect(report.boxes).toHaveLength(8);
    for (const [index, member] of members.entries()) {
      const sequences = [[1, 2], [7, 8], [9, 10], [11, 12]][index]!;
      const rows = report.rows.filter((row) => row.demandId === member.id), boxes = report.boxes.filter((box) => box.demandId === member.id);
      expect(rows).toHaveLength(2);
      expect(boxes.map((box) => [box.boxOrder, box.displayBoxOrder, box.code])).toEqual(sequences.map((sequence, order) => [order + 1, order + 1, `G${sequence}`]));
      for (const row of rows) {
        expect(row.quantity).toBe(2);
        expect(row.boxes.map((box) => [box.boxOrder, box.displayBoxOrder, box.quantity])).toEqual(sequences.map((_, order) => [order + 1, order + 1, 1]));
        expect(row.boxes.map((box) => box.boxId)).toEqual(boxes.map((box) => box.boxId));
      }
    }
    expect(report.rows.map((row) => row.demandId)).toEqual(members.flatMap((member) => [member.id, member.id]));
    expect(group).toEqual(before);
  });

  it('ignores invalid old and mismatched allocations and reads the sequence without parsing the code label', () => {
    const group = codedFixture([7, 8]), current = group.codes[0]!;
    current.code = 'original-box-code';
    group.codes.unshift(
      { ...current, id: randomUUID(), sequence: 99, code: 'G99', valid: false },
      { ...current, id: randomUUID(), demandId: randomUUID(), sequence: 90, code: 'G90' },
      { ...current, id: randomUUID(), groupId: randomUUID(), sequence: 91, code: 'G91' },
    );
    const report = project([group]);
    expect(report.maxBoxes).toBe(2);
    expect(report.boxes.find((box) => box.code === 'original-box-code')).toMatchObject({ boxOrder: 1, displayBoxOrder: 1, code: 'original-box-code' });
    expect(report.rows[0]!.boxes[0]).toMatchObject({ boxOrder: 1, displayBoxOrder: 1, code: 'original-box-code', quantity: 1 });
    expect(report.rows[0]!.codes).toEqual(['G8', 'original-box-code']);
  });

  it('preserves allocation gaps in the summary while compacting only display columns into local box order', () => {
    const group = codedFixture([1, 6, 12]);
    group.codes.unshift({ ...group.codes[0]!, id: randomUUID(), boxId: randomUUID(), sequence: 4, code: 'G4', valid: false });
    const report = project([group]);
    expect(report.maxBoxes).toBe(3);
    expect(report.boxes.map((box) => [box.boxOrder, box.displayBoxOrder])).toEqual([[1, 1], [2, 2], [3, 3]]);
    expect(report.rows[0]!.boxes.map((box) => box.displayBoxOrder)).toEqual([1, 2, 3]);
    expect(report.rows[0]!.codes).toEqual(['G1', 'G6', 'G12']);
    expect(report.rows[0]!.ticketCodeRange).toBe('G1、G6、G12');
  });

  it('keeps the real display columns for selected ticket members while excluding other FBA boxes and maxima', () => {
    const group = codedFixture([1, 2]), selected = appendMember(group, [7, 8], 'FBASELECTED');
    appendMember(group, [99, 100], 'FBAEXCLUDED');
    const scope: ShippingReportScope = { shippingRunId: randomUUID(), version: 3, numberingDate: '2026-10-23', month: '2026-10', sequence: 2,
      members: [{ demandId: selected.id, groupId: group.group.id, ticketId: randomUUID(), ticketNumber: '20261023-2-US-1', sourceTicketIndex: 1, inputOrder: 1 }] };
    const report = projectConfirmedGroups([group], {}, scope);
    expect(report).toMatchObject({ total: 2, maxBoxes: 2 });
    expect(report.boxes.map((box) => [box.fba, box.boxOrder, box.displayBoxOrder, box.code])).toEqual([
      ['FBASELECTED', 1, 1, 'G7'], ['FBASELECTED', 2, 2, 'G8'],
    ]);
    expect(report.rows.every((row) => row.fba === 'FBASELECTED' && row.groupQuantity === 2 && row.boxes.map((box) => box.displayBoxOrder).join() === '1,2' && row.ticketCodeRange === 'G7-G8')).toBe(true);
    assertShippingRunProjection(scope, report);
  });

  it('orders separate prefixes alphabetically while retaining their independent numeric display columns', () => {
    const one = codedFixture([7, 8], 'G'), two = codedFixture([7, 8], 'H'), ticketId = randomUUID();
    two.members[0]!.snapshot.fba = 'FBAOTHERPREFIX'; two.shipments[0]!.revision.data.fba = 'FBAOTHERPREFIX';
    const scope: ShippingReportScope = { shippingRunId: randomUUID(), version: 3, numberingDate: '2026-10-23', month: '2026-10', sequence: 2,
      members: [one, two].map((group, index) => ({ demandId: group.members[0]!.id, groupId: group.group.id, ticketId,
        ticketNumber: '20261023-2-US-1', sourceTicketIndex: 1, inputOrder: index === 0 ? 2 : 1 })) };
    for (const report of [project([one, two]), projectConfirmedGroups([one, two], {}, scope)]) {
      expect(report.maxBoxes).toBe(2); expect(report.boxes).toHaveLength(4);
      expect(report.rows).toHaveLength(4);
      expect(new Set(report.boxes.map((box) => box.boxId)).size).toBe(4);
      expect(report.boxes.filter((box) => box.displayBoxOrder === 1).map((box) => box.code).sort()).toEqual(['G7', 'H7']);
    }
    const report = projectConfirmedGroups([one, two], {}, scope);
    expect(report.rows.map((row) => row.groupId)).toEqual([two.group.id, two.group.id, one.group.id, one.group.id]);
  });

  it('sorts complete FBA blocks by allocated code before pagination, including multi-letter prefixes and ticket input in reverse order', () => {
    const groups = [codedFixture([1], 'AA'), codedFixture([1], 'Z'), codedFixture([10], 'A'), codedFixture([1], 'B'), codedFixture([2], 'A'), codedFixture([1], 'AB')];
    const expected = [groups[4]!, groups[2]!, groups[3]!, groups[1]!, groups[0]!, groups[5]!];
    const scope: ShippingReportScope = { shippingRunId: randomUUID(), version: 3, numberingDate: '2026-10-23', month: '2026-10', sequence: 2,
      members: groups.map((group, index) => ({ demandId: group.members[0]!.id, groupId: group.group.id, ticketId: randomUUID(),
        ticketNumber: `20261023-2-US-${index + 1}`, sourceTicketIndex: index, inputOrder: 0 })) };
    const before = structuredClone(groups);
    for (const reportScope of [undefined, scope]) {
      const pages = Array.from({ length: 6 }, (_, index) => projectConfirmedGroups(groups, { page: index + 1, pageSize: 2 }, reportScope));
      expect(pages.flatMap((page) => page.rows.map((row) => row.groupId))).toEqual((reportScope ? groups : expected).flatMap((group) => [group.group.id, group.group.id]));
      expect(pages[0]!.boxes.map((box) => box.code)).toEqual(['A2', 'A10', 'B1', 'Z1', 'AA1', 'AB1']);
      expect(pages.every((page) => page.total === 12 && page.maxBoxes === 1 && page.confirmations.length === 6)).toBe(true);
      expect(pages[5]!.boxes).toEqual(pages[0]!.boxes);
      const complete = projectConfirmedGroups(groups, { pageSize: 100 }, reportScope);
      if (reportScope) assertShippingRunProjection(reportScope, complete);
      for (const row of complete.rows) {
        expect(row.quantity).toBe(1);
        expect(row.boxes).toEqual([expect.objectContaining({ boxOrder: 1, displayBoxOrder: 1, quantity: 1 })]);
      }
    }
    expect(groups).toEqual(before);
  });

  it('sorts code lists and box detail naturally without changing local box coordinates or quantities', () => {
    const group = codedFixture([10, 2, 1]), before = structuredClone(group), report = project([group]);
    expect(report.rows[0]!.codes).toEqual(['G1', 'G2', 'G10']);
    expect(report.boxes.map((box) => [box.code, box.boxOrder, box.displayBoxOrder])).toEqual([['G1', 3, 3], ['G2', 2, 2], ['G10', 1, 1]]);
    expect(report.rows[0]!.boxes.map((box) => [box.code, box.boxOrder, box.displayBoxOrder, box.quantity])).toEqual([['G10', 1, 1, 1], ['G2', 2, 2, 1], ['G1', 3, 3, 1]]);
    expect(group).toEqual(before);
  });

  it('sorts by the first positive allocation column with stable ties while preserving local order and zero distributions', () => {
    const group = codedFixture([10, 7, 8], 'G', 5), data = group.shipments[0]!.revision.data;
    const quantities = [1, 2, 3, 4, 0];
    data.items = data.items.map((item, index) => ({ ...item, quantity: String(quantities[index]) }));
    const entries: Array<Array<[number, number]>> = [[[0, 1], [3, 4]], [[1, 2], [3, 0], [4, 0]], [[2, 3]]];
    for (const [index, box] of data.boxes.entries()) box.items = entries[index]!.map(([product, quantity]) => ({ ...data.items[product]!, quantity: String(quantity) }));
    const before = structuredClone(group), report = project([group]);
    expect(report.rows.map((row) => row.sku)).toEqual([3, 2, 1, 0, 4].map((index) => `SKU-Gamma-${index}`));
    expect(report.rows[0]!.boxes.map((box) => [box.boxOrder, box.displayBoxOrder, box.quantity])).toEqual([[1, 1, 4], [2, 2, 0]]);
    expect(report.rows[2]!.boxes[0]).toMatchObject({ boxOrder: 2, displayBoxOrder: 2, quantity: 2 });
    expect(report.rows[4]).toMatchObject({ quantity: 0, boxes: [expect.objectContaining({ boxOrder: 2, displayBoxOrder: 2, quantity: 0 })] });
    expect(group).toEqual(before);
  });

  it('keeps legacy stored projections readable and validates any provided display order as a positive integer', () => {
    const report = project([codedFixture([7, 8])]);
    const legacy = structuredClone(report);
    for (const row of legacy.rows) for (const box of row.boxes) delete box.displayBoxOrder;
    for (const box of legacy.boxes) delete box.displayBoxOrder;
    expect(reportResponseSchema.safeParse(legacy).success).toBe(true);
    for (const displayBoxOrder of [0, -1, 1.5]) {
      expect(reportResponseSchema.safeParse({ ...report, boxes: [{ ...report.boxes[0], displayBoxOrder }] }).success).toBe(false);
      expect(reportResponseSchema.safeParse({ ...report, rows: [{ ...report.rows[0], boxes: [{ ...report.rows[0]!.boxes[0], displayBoxOrder }] }] }).success).toBe(false);
    }
  });
});

describe('shipping-run ticket projection', () => {
  const scopeFor = (entries: Array<{ group: Confirmed; ticketId: string; sourceTicketIndex: number; inputOrder: number }>): ShippingReportScope => ({
    shippingRunId: randomUUID(), version: 3, numberingDate: '2026-10-23', month: '2026-10', sequence: 2,
    members: entries.map(({ group, ticketId, sourceTicketIndex, inputOrder }) => ({ demandId: group.members[0]!.id, groupId: group.group.id,
      ticketId, ticketNumber: `20261023-2-US-${sourceTicketIndex + 1}`, sourceTicketIndex, inputOrder })),
  });
  it('uses complete-ticket product totals consistently across FBA proportions, pagination and group searches', () => {
    const first = fixture({ name: 'Target shipment', products: 3, boxCount: 1 }), second = fixture({ name: 'Other shipment', products: 3, boxCount: 1 });
    for (const [index, group] of [first, second].entries()) {
      group.members[0]!.snapshot.fba = `FBA-TICKET-PROPORTION-${index}`;
      const data = group.shipments[0]!.revision.data;
      data.fba = group.members[0]!.snapshot.fba;
      const quantities = index === 0 ? [100, 20, 40] : [10, 80, 60];
      data.items = data.items.map((item, product) => ({ ...item, quantity: String(quantities[product]!) }));
      data.boxes[0]!.items = data.items.map((item) => ({ ...item }));
    }
    const ticketId = randomUUID(), scope = scopeFor([
      { group: first, ticketId, sourceTicketIndex: 0, inputOrder: 0 },
      { group: second, ticketId, sourceTicketIndex: 0, inputOrder: 1 },
    ]);
    const before = structuredClone([first, second]);
    const complete = projectConfirmedGroups([second, first], { pageSize: 100 }, scope);
    const order = ['SKU-Gamma-0', 'SKU-Gamma-1', 'SKU-Gamma-2'];
    expect(complete.rows.map((row) => row.sku)).toEqual([...order, ...order]);
    expect(complete.rows.map((row) => row.quantity)).toEqual([100, 20, 40, 10, 80, 60]);
    expect(complete.rows.map((row) => row.groupQuantity)).toEqual([110, 100, 100, 110, 100, 100]);
    const pageOne = projectConfirmedGroups([first, second], { pageSize: 4 }, scope);
    const pageTwo = projectConfirmedGroups([first, second], { pageSize: 4, page: 2 }, scope);
    expect([...pageOne.rows, ...pageTwo.rows]).toEqual(complete.rows);
    for (const group of [first, second]) group.shippingDetails = { [group.members[0]!.id]: {
      runId: scope.shippingRunId, month: scope.month, sequence: scope.sequence, ticketId,
      ticketNumber: scope.members[0]!.ticketNumber, sourceTicketIndex: 0, inputOrder: group === first ? 0 : 1,
    } };
    const searched = projectConfirmedGroups([first, second], { q: 'Target shipment', pageSize: 100 });
    expect(searched.rows.map((row) => row.sku)).toEqual(order);
    expect(searched.rows.map((row) => row.groupQuantity)).toEqual([110, 100, 100]);
    for (const [index, group] of [first, second].entries()) {
      expect({ ...group, shippingDetails: undefined }).toEqual({ ...before[index], shippingDetails: undefined });
    }
  });
  it('includes only explicit ticket members even when their old source group has other shipments', () => {
    const selected = fixture(), excluded = fixture({ products: 1, boxCount: 12 });
    selected.confirmation.snapshot.members.push(...excluded.members);
    selected.confirmation.snapshot.shipments.push(...excluded.shipments);
    selected.codes.push(...excluded.codes.map((code) => ({ ...code, groupId: selected.group.id })));
    // An unrelated member must not contribute quantities or even be parsed.
    excluded.shipments[0]!.revision.data.items[0]!.quantity = 'not-a-quantity';
    const scope = scopeFor([{ group: selected, ticketId: randomUUID(), sourceTicketIndex: 0, inputOrder: 0 }]);
    const report = reportResponseSchema.parse(projectConfirmedGroups([selected], {}, scope));
    expect(report).toMatchObject({ shippingRunId: scope.shippingRunId, shippingRunVersion: 3, shippingRunDate: '2026-10-23', shippingRunSequence: 2, total: 2, maxBoxes: 2 });
    expect(report.boxes).toHaveLength(2);
    expect(report.rows.every((row) => row.demandId === selected.members[0]!.id && row.ticketNumber === '20261023-2-US-1')).toBe(true);
    expect(report.rows.map((row) => row.groupQuantity)).toEqual([2, 2]);
    assertShippingRunProjection(scope, report);
  });

  it('sums across internal groups by ticket, seller and complete product identity, retaining input order', () => {
    const one = fixture(), two = fixture(), anotherSeller = fixture(), anotherTicket = fixture();
    anotherSeller.members[0]!.snapshot.sid = 22;
    const ticketId = randomUUID();
    const scope = scopeFor([
      { group: one, ticketId, sourceTicketIndex: 0, inputOrder: 2 },
      { group: two, ticketId, sourceTicketIndex: 0, inputOrder: 1 },
      { group: anotherSeller, ticketId, sourceTicketIndex: 0, inputOrder: 3 },
      { group: anotherTicket, ticketId: randomUUID(), sourceTicketIndex: 1, inputOrder: 0 },
    ]);
    const report = projectConfirmedGroups([anotherTicket, anotherSeller, one, two], { pageSize: 3 }, scope);
    expect(report.total).toBe(8); expect(report.rows).toHaveLength(3); expect(report.boxes).toHaveLength(8); expect(report.confirmations).toHaveLength(4);
    expect(report.rows.map((row) => row.demandId)).toEqual([two.members[0]!.id, two.members[0]!.id, one.members[0]!.id]);
    expect(report.rows.map((row) => row.groupQuantity)).toEqual([4, 4, 4]);
    const complete = projectConfirmedGroups([one, two, anotherSeller, anotherTicket], { pageSize: 100 }, scope);
    expect(complete.rows.filter((row) => row.sid === 22).map((row) => row.groupQuantity)).toEqual([2, 2]);
    expect(complete.rows.filter((row) => row.ticketId !== ticketId).map((row) => row.groupQuantity)).toEqual([2, 2]);
    expect(complete.rows.every((row) => row.groupQuantity === row.monthQuantity)).toBe(true);
    assertShippingRunProjection(scope, complete);
  });

  it('locates a complete ticket across groups and uses the numbering month rather than old demand dates', () => {
    const first = fixture({ name: 'Target internal group' }), second = fixture({ name: 'Other internal group' });
    const scope = scopeFor([
      { group: first, ticketId: randomUUID(), sourceTicketIndex: 0, inputOrder: 0 },
      { group: second, ticketId: randomUUID(), sourceTicketIndex: 1, inputOrder: 1 },
    ]);
    scope.members[1]!.ticketId = scope.members[0]!.ticketId;
    scope.members[1]!.ticketNumber = scope.members[0]!.ticketNumber;
    expect(projectConfirmedGroups([first, second], { q: 'target', month: '2026-10' }, scope).total).toBe(4);
    expect(projectConfirmedGroups([first, second], { q: '20261023-2-us-1' }, scope).boxes).toHaveLength(4);
    expect(projectConfirmedGroups([first, second], { month: '2026-09' }, scope).total).toBe(0);
    expect(projectConfirmedGroups([first, second], { subBatchId: first.group.id }, scope).confirmations).toHaveLength(2);
  });

  it('returns completed members for an incomplete preview and rejects missing members for ready exports', () => {
    const done = fixture(), pending = fixture();
    const scope = scopeFor([{ group: done, ticketId: randomUUID(), sourceTicketIndex: 0, inputOrder: 0 }, { group: pending, ticketId: randomUUID(), sourceTicketIndex: 1, inputOrder: 1 }]);
    expect(() => projectConfirmedGroups([done], {}, scope)).toThrow('本次发货的票成员已不属于原制表确认');
    expect(projectConfirmedGroups([done], {}, { ...scope, allowIncomplete: true }).total).toBe(2);
  });

  it('rejects export publication when run versions, ticket assignments or input order changed', () => {
    const group = fixture();
    const scope = scopeFor([{ group, ticketId: randomUUID(), sourceTicketIndex: 0, inputOrder: 0 }]);
    const projection = projectConfirmedGroups([group], {}, scope);
    for (const changed of [{ ...scope, version: 4 }, { ...scope, members: [{ ...scope.members[0]!, ticketId: randomUUID() }] }, { ...scope, members: [{ ...scope.members[0]!, inputOrder: 3 }] }, { ...scope, members: [] }]) {
      expect(() => assertShippingRunProjection(changed, projection)).toThrow('导出期间发货次版本或票成员已变化');
    }
  });

  it('requires a run version and rejects partial month or region exports while retaining legacy requests', () => {
    const groupId = randomUUID(), input = { operationId: randomUUID(), groupIds: [groupId], expectedConfirmations: [{ groupId, groupVersion: 2, confirmationId: randomUUID() }] };
    expect(reportExportInputSchema.safeParse(input).success).toBe(true);
    const run = { ...input, shippingRunId: randomUUID(), expectedShippingRunVersion: 3 };
    expect(reportExportInputSchema.safeParse(run).success).toBe(true);
    expect(reportExportInputSchema.safeParse({ ...run, expectedShippingRunVersion: undefined }).success).toBe(false);
    expect(reportExportInputSchema.safeParse({ ...run, month: '2026-10' }).success).toBe(false);
    expect(reportExportInputSchema.safeParse({ ...run, region: 'US' }).success).toBe(false);
  });
});

describe('shipment report workspace filters', () => {
  function addMember(target: Confirmed, source: Confirmed) {
    const member = source.confirmation.snapshot.members[0]!;
    target.confirmation.snapshot.members.push(member);
    target.confirmation.snapshot.shipments.push(...source.confirmation.snapshot.shipments);
    target.group.demandIds.push(member.id);
    target.codes.push(...source.codes.map((code) => ({ ...code, groupId: target.group.id })));
    return member;
  }

  it('locates complete groups by confirmed identity and keeps all boxes and references across pages', () => {
    const excluded = fixture({ name: 'Other group', boxCount: 12 });
    const group = fixture({ name: 'Selected group' });
    const addition = fixture();
    const member = addMember(group, addition);
    member.weekStartDate = '2026-09-14'; member.weekEndDate = '2026-09-20';
    member.snapshot.sid = 22; member.snapshot.country = '英国'; member.snapshot.channel = 'SY';
    // Mutable current metadata must not replace the accepted snapshot identity.
    group.members = structuredClone(group.confirmation.snapshot.members);
    group.members[1]!.snapshot.sid = 99;
    const filter: ReportFilter = { weekStartDate: '2026-09-14', sid: 22, country: '英国', channel: 'SY', pageSize: 1, q: 'selected' };
    const first = project([excluded, group], filter), second = project([excluded, group], { ...filter, page: 2 });
    expect(first).toMatchObject({ total: 4, maxBoxes: 2 });
    expect(first.rows).toHaveLength(1); expect(first.boxes).toHaveLength(4);
    expect(first.rows[0]!.sid).toBe(11);
    expect(first.confirmations).toEqual([{ groupId: group.group.id, groupVersion: 2, confirmationId: group.confirmation.id }]);
    expect(second.boxes).toEqual(first.boxes); expect(second.confirmations).toEqual(first.confirmations);
    expect(project([group], { sid: 99 }).total).toBe(0);
  });

  it('requires every locator to match the same member and stays within the applied month and region', () => {
    const group = fixture();
    const october = addMember(group, fixture());
    october.businessDate = '2026-10-01'; october.weekStartDate = '2026-09-28'; october.snapshot.sid = 22;
    const europe = addMember(group, fixture());
    europe.snapshot.country = '英国'; europe.snapshot.channel = 'SY'; europe.snapshot.sid = 33;
    expect(project([group], { sid: 22, channel: 'SY' }).total).toBe(0);
    expect(project([group], { month: '2026-09', sid: 22 }).confirmations).toEqual([]);
    expect(project([group], { region: 'US', country: '英国' }).boxes).toEqual([]);
    const result = project([group], { month: '2026-09', region: 'US', weekStartDate: '2026-09-07', sid: 11, country: '美国', channel: 'HY' });
    expect(result.total).toBe(2); expect(result.boxes).toHaveLength(2);
    expect(result.rows.every((row) => row.businessDate.startsWith('2026-09') && row.country === '美国')).toBe(true);
    expect(result.confirmations).toHaveLength(1);
  });

  it.each<ReportFilter>([{ weekStartDate: '2026-09-14' }, { sid: 99 }, { country: 'US' }, { channel: 'SY' }])('returns an empty complete scope for an unmatched locator %o', (filter) => {
    expect(project([fixture()], filter)).toMatchObject({ rows: [], boxes: [], confirmations: [], total: 0, maxBoxes: 0 });
  });
});
