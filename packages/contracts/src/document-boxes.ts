import type { DocumentMemberSnapshot } from './documents.js';
import type { PhysicalBox } from './physical.js';

export const DOCUMENT_BOX_FIELDS = ['weight', 'length', 'width', 'height', 'po'] as const;
export type DocumentBoxField = typeof DOCUMENT_BOX_FIELDS[number];
export type DocumentBoxMember = Pick<DocumentMemberSnapshot, 'demand' | 'shipment' | 'codes' | 'physical' | 'boxSource'>;
export const documentBoxFieldKey = (boxId: string, field: DocumentBoxField): string => `box.${boxId}.${field}`;

/** Exact positive decimal conversion, with a single half-up rounding to KG/CM. */
export function documentBoxValue(value: unknown, unit: unknown, kind: 'weight' | 'dimension'): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) return null;
  const text = String(value).trim(), normalizedUnit = typeof unit === 'string' ? unit.trim().toUpperCase() : '';
  if (text.length > 100 || !/^\+?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const multiplier = kind === 'weight' ? normalizedUnit === 'KG' ? [1n, 1n] : normalizedUnit === 'LB' ? [45359237n, 100000000n] : null
    : normalizedUnit === 'CM' ? [1n, 1n] : normalizedUnit === 'IN' ? [254n, 100n] : null;
  if (!multiplier) return null;
  const [whole = '', fraction = ''] = text.replace(/^\+/, '').split('.');
  const numerator = BigInt(`${whole || '0'}${fraction}`) * multiplier[0]! * 100n, denominator = 10n ** BigInt(fraction.length) * multiplier[1]!;
  const cents = (numerator * 2n + denominator) / (denominator * 2n);
  if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER) * 100n) return null;
  const result = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
  // XLSX writes JavaScript numbers. Reject decimal cents lost by that conversion.
  const numeric = String(Number(result)), match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(numeric);
  if (!match || BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0')) !== cents) return null;
  return result;
}

/** Immutable automatic values. Legacy invoices retain their original M3 snapshot. */
export function documentBoxSources(member: DocumentBoxMember): PhysicalBox[] {
  const source = member.boxSource ?? member.physical?.snapshot.source.boxes;
  if (source) return structuredClone(source.filter((box) => box.demandId === member.demand.id && box.shipmentRevisionId === member.shipment.id)).sort((a, b) => a.order - b.order);
  return member.shipment.data.boxes.map((box): PhysicalBox => {
    const raw = { weight: box.weight ?? null, length: box.length ?? null, width: box.width ?? null, height: box.height ?? null, weightUnit: box.weightUnit ?? null, dimensionUnit: box.dimensionUnit ?? null };
    const values = { weight: documentBoxValue(raw.weight, raw.weightUnit, 'weight'), length: documentBoxValue(raw.length, raw.dimensionUnit, 'dimension'), width: documentBoxValue(raw.width, raw.dimensionUnit, 'dimension'), height: documentBoxValue(raw.height, raw.dimensionUnit, 'dimension') };
    const codes = member.codes.filter((code) => code.valid && code.demandId === member.demand.id && code.boxId === box.id);
    return { demandId: member.demand.id, shipmentRevisionId: member.shipment.id, boxId: box.id, sid: member.shipment.data.sid, fba: member.shipment.data.fba,
      code: codes.length === 1 ? codes[0]!.code : '', order: box.order ?? 0, po: null, range: `${member.shipment.data.fba}000001-${member.shipment.data.boxes.length}`,
      raw, values, items: structuredClone(box.items), sourceObservedAt: member.shipment.data.observedAt };
  }).sort((a, b) => a.order - b.order);
}

/** Absent/null overrides restore automatic values; an empty override stays missing. */
export function documentBoxes(member: DocumentBoxMember, fields: Readonly<Record<string, string | null>> = {}): PhysicalBox[] {
  return documentBoxSources(member).map((box) => {
    const values = { ...box.values };
    for (const field of ['weight', 'length', 'width', 'height'] as const) {
      const override = fields[documentBoxFieldKey(box.boxId, field)];
      values[field] = documentBoxValue(override !== undefined && override !== null ? override : values[field], field === 'weight' ? 'KG' : 'CM', field === 'weight' ? 'weight' : 'dimension');
    }
    const po = fields[documentBoxFieldKey(box.boxId, 'po')];
    return { ...box, values, po: po === undefined || po === null ? box.po : po.trim() || null };
  });
}
