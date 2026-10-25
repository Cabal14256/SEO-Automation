import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { documentBoxFieldKey, documentBoxes, workflowBoxes, type DocumentMemberSnapshot, type DocumentRevisionData, type WorkflowSource } from '@scm/contracts';
import { projectDocumentLines } from '../documents/workbook.js';

function fixture() {
  const boxId = randomUUID(), at = '2026-10-23T00:00:00.000Z';
  const member = {
    source: { groupId: randomUUID(), demandId: randomUUID(), physicalConfirmationId: null },
    demand: { id: randomUUID(), snapshot: { sid: 1, fba: 'FBA-BOX-VALUES', country: 'US', channel: 'TECH' } },
    shipment: { id: randomUUID(), data: { fba: 'FBA-BOX-VALUES', observedAt: at,
      boxes: [{ id: boxId, order: 1, weight: '10', weightUnit: 'LB', length: '10', width: '5', height: '4', dimensionUnit: 'IN',
        items: [{ msku: 'M', fnsku: 'F', sku: 'S', quantity: '2' }] }] } },
    codes: [{ boxId, code: 'A1' }], physical: null,
  } as unknown as DocumentMemberSnapshot;
  const source = { fields: { [documentBoxFieldKey(boxId, 'po')]: 'PO-ADOPTED', [documentBoxFieldKey(boxId, 'length')]: '32.40',
    [documentBoxFieldKey(boxId, 'weight')]: '7.50' }, members: [member] } as unknown as WorkflowSource;
  return { source, member, boxId };
}

describe('invoice carton values in downstream workflows', () => {
  it('uses the invoice adopted measurements and PO, retaining box identities and original source data', () => {
    const { source, member, boxId } = fixture(), original = structuredClone(source);
    const box = workflowBoxes(source)[0]!;
    expect(box).toMatchObject({ id: boxId, code: 'A1', po: 'PO-ADOPTED', weight: '7.50', weightUnit: 'KG',
      length: '32.40', width: '12.70', height: '10.16', dimensionUnit: 'CM' });
    const invoiceBox = documentBoxes(member, source.fields)[0]!;
    const projection = projectDocumentLines({ fields: source.fields, members: source.members, profileReferences: [] } as unknown as DocumentRevisionData);
    expect(projection.lines[0]!.box.values).toEqual(invoiceBox.values);
    expect(projection.lines[0]!.box.po).toBe(box.po);
    expect(projection.totalWeight).toBe('7.50');
    expect(source).toEqual(original);
  });

  it('restores normalized source values on null overrides and preserves a missing adopted value', () => {
    const { source, boxId } = fixture();
    source.fields[documentBoxFieldKey(boxId, 'weight')] = null;
    expect(workflowBoxes(source)[0]!.weight).toBe('4.54');
    source.fields[documentBoxFieldKey(boxId, 'weight')] = '';
    expect(workflowBoxes(source)[0]!.weight).toBeNull();
  });
});
