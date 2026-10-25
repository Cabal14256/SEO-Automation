import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { physicalEntrySchema, type AllocationCode, type BatchIssue, type GroupConfirmation, type PhysicalBox, type PhysicalEntry, type PhysicalSource, type ShipmentBox, type ShipmentData } from '@scm/contracts';
import type { LingxingReadPayload } from '../lingxing/read-client.js';
import { integerQuantity, normalizeShipment } from '../batches/sync.js';

export class PhysicalValidationError extends Error {
  readonly status = 422;
  constructor(public readonly code: string, message: string) { super(message); this.name = 'PhysicalValidationError'; }
}
export type PhysicalEvidence = { demandId: string; listing: Record<string, unknown>; details: LingxingReadPayload; packing: LingxingReadPayload; observedAt: string; snapshotIds: string[] };
export type BuildPhysicalSourceInput = {
  id: string; groupId: string; m2ConfirmationId: string; origin: 'history' | 'sync'; createdBy: string; createdAt: string;
  shipments: GroupConfirmation['snapshot']['shipments']; members: GroupConfirmation['snapshot']['members']; codes: AllocationCode[]; evidence: PhysicalEvidence[];
};
const Exact = Decimal.clone({ precision: 120, rounding: Decimal.ROUND_HALF_UP });
const fields = ['weight', 'length', 'width', 'height'] as const;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
const rawText = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
const fba = (value: unknown) => text(value)?.toUpperCase() ?? '';
const key = (box: Pick<PhysicalBox, 'shipmentRevisionId' | 'boxId'>) => JSON.stringify([box.shipmentRevisionId, box.boxId]);
const productKey = (item: { msku: string; fnsku: string; sku: string }) => JSON.stringify([item.msku, item.fnsku, item.sku]);
const quantity = (value: string | null) => value !== null && /^\d+$/.test(value) ? BigInt(value).toString() : null;
function itemSignature(items: ShipmentBox['items'] | ShipmentData['items']) {
  return JSON.stringify(items.map((item) => [productKey(item), quantity(item.quantity)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
const sourceBoxKey = (box: Pick<ShipmentBox, 'externalBoxId' | 'packageId' | 'localBoxId' | 'name' | 'items'>) => JSON.stringify([box.externalBoxId, box.packageId, box.localBoxId, box.name, itemSignature(box.items)]);
function positive(value: unknown): Decimal | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) return null;
  const raw = String(value).trim();
  if (raw.length > 100 || !/^\+?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return null;
  try { const number = new Exact(raw); return number.isFinite() && number.gt(0) ? number : null; } catch { return null; }
}
/** Conversion uses decimal arithmetic; rounding happens once after conversion. */
export function normalizePhysicalValue(value: unknown, unit: unknown, kind: 'weight' | 'dimension'): string | null {
  const number = positive(value), normalized = text(unit)?.toUpperCase();
  const multiplier = kind === 'weight' ? normalized === 'KG' ? '1' : normalized === 'LB' ? '0.45359237' : null : normalized === 'CM' ? '1' : normalized === 'IN' ? '2.54' : null;
  if (!number || !multiplier) return null;
  const rounded = number.times(multiplier).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return rounded.gt(0) && Number.isFinite(rounded.toNumber()) && rounded.lte(Number.MAX_SAFE_INTEGER) ? rounded.toFixed(2) : null;
}

export function physicalSourceFingerprint(source: Pick<PhysicalSource, 'boxes' | 'identityValid' | 'issues'>): string {
  const boxes = source.boxes.map((box) => ({ demandId: box.demandId, shipmentRevisionId: box.shipmentRevisionId, boxId: box.boxId, sid: box.sid, fba: box.fba,
    items: JSON.parse(itemSignature(box.items)) as unknown, values: fields.map((field) => box.values[field]), po: box.po,
    missing: fields.filter((field) => box.values[field] === null) })).sort((a, b) => JSON.stringify([a.demandId, a.shipmentRevisionId, a.boxId]).localeCompare(JSON.stringify([b.demandId, b.shipmentRevisionId, b.boxId])));
  const blockers = source.issues.filter((issue) => issue.severity === 'error').map((issue) => [issue.code, issue.demandId ?? '', issue.boxId ?? '']).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify({ boxes, identityValid: source.identityValid, blockers })).digest('hex');
}

export function buildPhysicalSource(input: BuildPhysicalSourceInput): PhysicalSource {
  const issues: BatchIssue[] = [], boxes: PhysicalBox[] = [], snapshotIds = new Set<string>();
  let identityValid = true;
  const add = (code: string, message: string, demandId?: string, boxId?: string) => issues.push({ code, severity: 'error', message, ...(demandId ? { demandId } : {}), ...(boxId ? { boxId } : {}) });
  const validCodes = new Map<string, AllocationCode[]>();
  for (const code of input.codes) if (code.valid && code.groupId === input.groupId) {
    const codeKey = JSON.stringify([code.demandId, code.boxId]); validCodes.set(codeKey, [...validCodes.get(codeKey) ?? [], code]);
  }
  const seenDemands = new Set<string>();
  for (const shipment of input.shipments) {
    const { demandId, revision } = shipment, expected = revision.data;
    const evidence = input.evidence.filter((entry) => entry.demandId === demandId), member = input.members.find((entry) => entry.id === demandId);
    if (seenDemands.has(demandId) || !member || member.snapshot.sid !== expected.sid || fba(member.snapshot.fba) !== fba(expected.fba)) {
      add('PHYSICAL_MEMBER_IDENTITY_CONFLICT', 'M2 成员与货件身份不一致。', demandId); identityValid = false;
    }
    seenDemands.add(demandId);
    let fresh: ShipmentData | null = null, po: string | null = null;
    const rawByIdentity = new Map<string, Record<string, unknown>[]>();
    const evidenceRow = evidence.length === 1 ? evidence[0]! : undefined;
    if (!evidenceRow) { add(evidence.length ? 'PHYSICAL_EVIDENCE_AMBIGUOUS' : 'PHYSICAL_EVIDENCE_MISSING', evidence.length ? '该票存在多份未明确采用的来源。' : '缺少可信领星原始证据，请显式同步。', demandId); identityValid = false; }
    else {
      evidenceRow.snapshotIds.forEach((id) => snapshotIds.add(id));
      try {
        if (String(evidenceRow.details.code) !== '0' || String(evidenceRow.packing.code) !== '0') throw new PhysicalValidationError('PHYSICAL_EVIDENCE_FAILED', '原始来源不是成功的领星响应。');
        fresh = normalizeShipment({ sid: expected.sid, fba: expected.fba, listing: evidenceRow.listing, details: evidenceRow.details, packing: evidenceRow.packing, previous: expected, observedAt: evidenceRow.observedAt });
        // The caller has already verified the effective M2 confirmation. A
        // recorded M2 decision may accept detail quantity over list quantity;
        // compare that accepted detail and every box below instead of vetoing
        // the established quantity basis again in M3.
        const ignored = new Set(['BOX_MAPPING_REQUIRED', 'BOX_MAPPING_CONFLICT', 'BOX_ORDER_REQUIRED', 'MISSING_PRODUCT_NAME', 'LIST_QUANTITY_MISMATCH']);
        for (const issue of fresh.issues.filter((entry) => entry.code === 'LIST_QUANTITY_MISMATCH')) issues.push({ ...issue, code: 'PHYSICAL_LIST_QUANTITY_MISMATCH', severity: 'warning', demandId });
        for (const issue of fresh.issues.filter((entry) => entry.severity === 'error' && !ignored.has(entry.code))) { add(`PHYSICAL_${issue.code}`, issue.message, demandId); identityValid = false; }
        if (itemSignature(fresh.items) !== itemSignature(expected.items)) { add('PHYSICAL_PRODUCT_QUANTITY_CONFLICT', '来源商品身份或申报数量与 M2 确认不一致，请走 M2 更正流程。', demandId); identityValid = false; }
        const detailMatches = rows(object(evidenceRow.details.data).shipmentList).filter((entry) => String(entry.sid) === String(expected.sid) && fba(entry.shipmentConfirmationId) === fba(expected.fba));
        const shipmentId = text(evidenceRow.listing.sta_shipment_id) ?? text(detailMatches[0]?.shipmentId);
        const rawGroups = rows(object(evidenceRow.packing.data).shipmentList).filter((entry) => text(entry.shipmentId) === shipmentId);
        for (const row of rows(rawGroups[0]?.shipmentPackingList)) {
          const rawKey = sourceBoxKey({ externalBoxId: rawText(row.boxId), packageId: rawText(row.packageId), localBoxId: rawText(row.localBoxId), name: rawText(row.box_name) ?? rawText(row.boxName),
            items: rows(row.productList).map((item) => ({ msku: rawText(item.msku) ?? '', fnsku: rawText(item.fnsku) ?? '', sku: rawText(item.sku) ?? '', quantity: integerQuantity(item.quantityInBox) })) });
          rawByIdentity.set(rawKey, [...rawByIdentity.get(rawKey) ?? [], row]);
        }
        const listed = text(evidenceRow.listing.reference_id), detailed = text(detailMatches[0]?.amazonReferenceId);
        if (listed && detailed && listed !== detailed) add('PHYSICAL_REFERENCE_CONFLICT', '列表与详情 Reference ID 不一致，请回领星核对。', demandId);
        else po = listed ?? detailed;
        if (!po && !(listed && detailed)) add('PHYSICAL_REFERENCE_REQUIRED', '缺少对应 FBA 的 Reference ID。', demandId);
      } catch (error) { add('PHYSICAL_IDENTITY_CONFLICT', error instanceof Error ? error.message : '来源货件身份无法核验。', demandId); identityValid = false; }
    }
    const expectedIds = new Set(expected.boxes.map((box) => box.id));
    if (!expected.boxes.length || expectedIds.size !== expected.boxes.length) { add('PHYSICAL_BOX_IDENTITY_CONFLICT', 'M2 实际箱清单为空或内部箱 ID 重复。', demandId); identityValid = false; }
    const used = new Set<string>();
    const byExternal = new Map<string, ShipmentBox[]>(), byPackage = new Map<string, ShipmentBox[]>(), byWeak = new Map<string, ShipmentBox[]>();
    for (const candidate of fresh?.boxes ?? []) {
      for (const [map, value] of [[byExternal, candidate.externalBoxId], [byPackage, candidate.packageId], [byWeak, candidate.localBoxId && candidate.name ? JSON.stringify([candidate.localBoxId, candidate.name, itemSignature(candidate.items)]) : null]] as const) {
        if (value) map.set(value, [...map.get(value) ?? [], candidate]);
      }
    }
    for (const box of expected.boxes) {
      const strong = Boolean(box.externalBoxId || box.packageId);
      const strongCandidates = box.externalBoxId ? byExternal.get(box.externalBoxId) ?? [] : box.packageId ? byPackage.get(box.packageId) ?? [] : [];
      const candidates = strong ? strongCandidates.filter((candidate) => (!box.externalBoxId || candidate.externalBoxId === box.externalBoxId) && (!box.packageId || candidate.packageId === box.packageId))
        : box.localBoxId && box.name ? byWeak.get(JSON.stringify([box.localBoxId, box.name, itemSignature(box.items)])) ?? [] : [];
      const candidate = candidates.length === 1 && !used.has(candidates[0]!.id) ? candidates[0]! : null;
      if (candidate) used.add(candidate.id);
      if (fresh && (!candidate || itemSignature(candidate.items) !== itemSignature(box.items))) { add('PHYSICAL_BOX_IDENTITY_CONFLICT', '来源箱身份、商品或箱内数量与 M2 不一致，请走 M2 映射／更正流程。', demandId, box.id); identityValid = false; }
      const matches = validCodes.get(JSON.stringify([demandId, box.id])) ?? [];
      const code = matches.length === 1 ? matches[0]!.code : '';
      if (!code) add('PHYSICAL_CODE_REQUIRED', '该箱缺少唯一有效内部箱码。', demandId, box.id);
      if (box.order === null) { add('PHYSICAL_BOX_ORDER_REQUIRED', 'M2 箱序缺失。', demandId, box.id); identityValid = false; }
      const originalMatches = candidate ? rawByIdentity.get(sourceBoxKey(candidate)) ?? [] : [], original = originalMatches.length === 1 ? originalMatches[0] : undefined;
      const raw = { weight: rawText(original?.weight), length: rawText(original?.length), width: rawText(original?.width), height: rawText(original?.height), weightUnit: rawText(original?.weightUnit), dimensionUnit: rawText(original?.lengthUnit) };
      const values = { weight: normalizePhysicalValue(raw.weight, raw.weightUnit, 'weight'), length: normalizePhysicalValue(raw.length, raw.dimensionUnit, 'dimension'), width: normalizePhysicalValue(raw.width, raw.dimensionUnit, 'dimension'), height: normalizePhysicalValue(raw.height, raw.dimensionUnit, 'dimension') };
      for (const field of fields) if (values[field] === null) add(`PHYSICAL_${field.toUpperCase()}_REQUIRED`, `该箱领星${({ weight: '毛重', length: '长度', width: '宽度', height: '高度' })[field]}缺失、非正数或单位无效。`, demandId, box.id);
      boxes.push({ demandId, shipmentRevisionId: revision.id, boxId: box.id, sid: expected.sid, fba: expected.fba, code, order: box.order ?? 1, po,
        range: `${expected.fba}000001-${expectedIds.size}`, raw, values, items: structuredClone(box.items), sourceObservedAt: evidenceRow?.observedAt ?? input.createdAt });
    }
    if (fresh && used.size !== fresh.boxes.length) { add('PHYSICAL_BOX_MEMBERSHIP_CONFLICT', '来源实际箱成员与 M2 确认不一致。', demandId); identityValid = false; }
  }
  if (input.members.length !== input.shipments.length || input.evidence.some((entry) => !seenDemands.has(entry.demandId))) { add('PHYSICAL_MEMBERSHIP_CONFLICT', '来源成员清单与 M2 确认不一致。'); identityValid = false; }
  const source: PhysicalSource = { id: input.id, groupId: input.groupId, m2ConfirmationId: input.m2ConfirmationId, origin: input.origin, fingerprint: '', boxes: boxes.sort((a, b) => a.fba.localeCompare(b.fba) || a.sid - b.sid || a.order - b.order || a.boxId.localeCompare(b.boxId)), issues, identityValid, snapshotIds: [...snapshotIds].sort(), createdBy: input.createdBy, createdAt: input.createdAt };
  source.fingerprint = physicalSourceFingerprint(source);
  return source;
}

export const pendingEntries = (source: PhysicalSource): PhysicalEntry[] => source.boxes.map((box) => ({ shipmentRevisionId: box.shipmentRevisionId, boxId: box.boxId, status: 'pending', measured: {}, reason: '' }));

/** Every revision is a complete box list; a draft may retain unfinished rows. */
export function validatePhysicalEntries(source: PhysicalSource, entries: PhysicalEntry[], requireComplete = false): PhysicalEntry[] {
  const expected = new Map(source.boxes.map((box) => [key(box), box])), seen = new Set<string>();
  if (entries.length !== expected.size) throw new PhysicalValidationError('PHYSICAL_BOX_LIST_CHANGED', '核对必须包含当前版本的完整箱清单。');
  if (requireComplete && (!source.identityValid || source.issues.some((issue) => issue.severity === 'error') || !source.boxes.length)) throw new PhysicalValidationError('PHYSICAL_SOURCE_BLOCKED', '来源仍有阻塞项，无法最终确认。');
  const result = entries.map((entry) => {
    const parsed = physicalEntrySchema.safeParse(entry);
    if (!parsed.success) throw new PhysicalValidationError('PHYSICAL_ENTRY_INVALID', '核对结果格式无效。');
    const normalized = parsed.data, entryKey = key(normalized), box = expected.get(entryKey);
    if (!box || seen.has(entryKey)) throw new PhysicalValidationError('PHYSICAL_BOX_LIST_CHANGED', '核对箱身份重复或与当前版本不一致。');
    seen.add(entryKey);
    const measured: PhysicalEntry['measured'] = {};
    for (const field of fields) if (normalized.measured[field] !== undefined && normalized.measured[field]!.trim() !== '') {
      const value = normalizePhysicalValue(normalized.measured[field], field === 'weight' ? 'KG' : 'CM', field === 'weight' ? 'weight' : 'dimension');
      if (!value) throw new PhysicalValidationError('PHYSICAL_MEASUREMENT_INVALID', '实测重量和尺寸必须为有效正数，单位为 KG／CM。');
      measured[field] = value;
    }
    if (normalized.status === 'consistent' && Object.keys(measured).length) throw new PhysicalValidationError('PHYSICAL_MEASUREMENT_UNEXPECTED', '选择一致时不能填写实测值。');
    if (requireComplete && normalized.status === 'pending') throw new PhysicalValidationError('PHYSICAL_REVIEW_INCOMPLETE', '全部箱核对完成后才能确认。');
    if (normalized.status === 'different') {
      const different = fields.some((field) => measured[field] !== undefined && measured[field] !== box.values[field]);
      if (requireComplete && (!different || !normalized.reason.trim())) throw new PhysicalValidationError('PHYSICAL_DIFFERENCE_INCOMPLETE', '有差异的箱必须填写至少一项不同的实测值及原因。');
    }
    return { ...normalized, measured, reason: normalized.reason.trim() };
  });
  const byKey = new Map(result.map((entry) => [key(entry), entry]));
  return source.boxes.map((box) => byKey.get(key(box))!);
}
