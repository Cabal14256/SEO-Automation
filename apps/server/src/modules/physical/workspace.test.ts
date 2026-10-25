import { describe, expect, it } from 'vitest';
import { physicalWorkspaceQuerySchema, physicalWorkspaceSchema, type DemandRecord, type PhysicalConfirmation } from '@scm/contracts';
import { projectPhysicalWorkspace, type PhysicalWorkspaceEntry } from './workspace.js';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const member = (value: number, sid = 1, country = 'US', channel = 'SEA'): DemandRecord => ({ id: id(value), version: 1, businessDate: '2026-10-19', weekStartDate: '2026-10-19', weekEndDate: '2026-10-25', createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z',
  snapshot: { sid, fba: `FBA${value}`, shop: `Shop ${sid}`, country, channel, destinationFc: 'LAX9', destinationAddress: '', referenceQuantity: null, notes: '', subBatchName: '' } } as DemandRecord);
const entry = (value: number): PhysicalWorkspaceEntry => ({ batch: { id: id(value + 100), weekStartDate: '2026-10-19', weekEndDate: '2026-10-25' }, group: { id: id(value), name: `组 ${value}`, status: 'confirmed' }, members: [member(value)],
  review: { version: 0, revision: null, source: null, valid: false, canExport: false, pendingChange: false, blocked: [{ code: 'SOURCE_REQUIRED', message: '需要来源', severity: 'error' }], confirmation: null } });

describe('physical workspace projection', () => {
  it('lists unstarted reviews without inventing confirmation and produces a valid contract', () => {
    const result = projectPhysicalWorkspace([entry(1)], physicalWorkspaceQuerySchema.parse({}));
    expect(physicalWorkspaceSchema.safeParse(result).success).toBe(true);
    expect(result.rows[0]?.physical).toMatchObject({ status: 'pending', version: 0, valid: false, boxCount: 0, confirmationId: null, exportReference: null });
    expect(result.filters.shops).toEqual([{ sid: 1, name: 'Shop 1' }]);
  });
  it('exposes an exact export reference only for a current exportable confirmation', () => {
    const current = entry(1);
    current.review.confirmation = { id: id(11), groupId: id(1), m2ConfirmationId: id(12), m3Version: 3, sourceFingerprint: 'current-source', createdAt: '2026-10-19T00:00:00Z' } as PhysicalConfirmation;
    current.review.valid = true; current.review.canExport = true; current.review.blocked = [];
    const reference = { groupId: id(1), m2ConfirmationId: id(12), physicalConfirmationId: id(11), m3Version: 3, sourceFingerprint: 'current-source' };
    expect(projectPhysicalWorkspace([current], physicalWorkspaceQuerySchema.parse({})).rows[0]?.physical.exportReference).toEqual(reference);
    current.review.canExport = false;
    expect(projectPhysicalWorkspace([current], physicalWorkspaceQuerySchema.parse({})).rows[0]?.physical.exportReference).toBeNull();
    current.review.canExport = true; current.review.valid = false;
    expect(projectPhysicalWorkspace([current], physicalWorkspaceQuerySchema.parse({})).rows[0]?.physical.exportReference).toBeNull();
    current.review.valid = true; current.review.confirmation = null;
    expect(projectPhysicalWorkspace([current], physicalWorkspaceQuerySchema.parse({})).rows[0]?.physical.exportReference).toBeNull();
  });
  it('requires store, country and channel to match the same shipment', () => {
    const first = entry(1); first.members = [member(1, 1, 'US', 'SEA'), member(2, 2, 'DE', 'AIR')];
    expect(projectPhysicalWorkspace([first], physicalWorkspaceQuerySchema.parse({ sid: 1, country: 'DE' })).total).toBe(0);
    expect(projectPhysicalWorkspace([first], physicalWorkspaceQuerySchema.parse({ sid: 2, country: 'DE', channel: 'AIR', q: 'fba2' })).total).toBe(1);
  });
  it('filters current confirmation, stale source and blocked review states before paging', () => {
    const confirmed = entry(1); confirmed.review.valid = true;
    const stale = entry(2); stale.review.pendingChange = true;
    const blocked = entry(3); blocked.review.blocked = [{ code: 'CODES_REQUIRED', message: '需要编码', severity: 'error' }];
    expect(projectPhysicalWorkspace([confirmed, stale, blocked], physicalWorkspaceQuerySchema.parse({ status: 'confirmed' })).rows.map((row) => row.id)).toEqual([id(1)]);
    expect(projectPhysicalWorkspace([confirmed, stale, blocked], physicalWorkspaceQuerySchema.parse({ status: 'stale' })).rows.map((row) => row.id)).toEqual([id(2)]);
    expect(projectPhysicalWorkspace([confirmed, stale, blocked], physicalWorkspaceQuerySchema.parse({ status: 'blocked' })).rows.map((row) => row.id)).toEqual([id(3)]);
  });
  it('filters shipment occurrences and paginates independently of import dates', () => {
    const entries = Array.from({ length: 23 }, (_, index) => entry(index + 1));
    for (const entry of entries) entry.shippingRuns = [{ id: id(999), month: '2026-11', sequence: 2, numberingDate: '2026-11-03' }];
    const result = projectPhysicalWorkspace(entries, physicalWorkspaceQuerySchema.parse({ month: '2026-11', shippingRunId: id(999), page: 2 }));
    expect(result.total).toBe(23); expect(result.rows).toHaveLength(3);
    expect(projectPhysicalWorkspace(entries, physicalWorkspaceQuerySchema.parse({ month: '2026-10' })).total).toBe(0);
  });
  it.each([{ weekFrom: '2026-10-26', weekTo: '2026-10-19' }, { pageSize: 100 }, { status: 'frozen' }, { sid: 0 }])('rejects invalid filter %j', (input) => {
    expect(physicalWorkspaceQuerySchema.safeParse(input).success).toBe(false);
  });
});
