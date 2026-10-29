import { documentBoxes, documentInvoiceBoxGroups, documentProductSourceFact, documentRepresentativeProduct, type DocumentRevisionData } from '@scm/contracts';

export const invoiceProductIdentity = (sid: number, item: { msku: string; fnsku: string; sku: string }) => JSON.stringify([sid, item.msku, item.fnsku, item.sku]);

const validQuantity = (value: string | null | undefined): number | null => {
  if (!value || !/^\d+$/.test(value)) return null;
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null;
};
const actualBoxQuantity = (box: ReturnType<typeof documentBoxes>[number]) => {
  const quantities = box.items.map((item) => validQuantity(item.quantity));
  const total = quantities.reduce<number>((sum, quantity) => sum + (quantity ?? 0), 0);
  return quantities.every((quantity) => quantity !== null) && Number.isSafeInteger(total) && total > 0 ? total : null;
};

export function invoiceBoxPreview(data: DocumentRevisionData, fields = data.fields) {
  return data.members.flatMap((member) => {
    const boxes = documentBoxes(member, fields);
    const groups = data.generationRulesVersion === 'v2' ? documentInvoiceBoxGroups(boxes) : [];
    const boxGroups = new Map(groups.flatMap((group) => group.boxes.map((box) => [box.boxId, group] as const)));
    return boxes.map((box) => {
      const group = boxGroups.get(box.boxId);
      const representative = data.generationRulesVersion === 'v2' ? group?.representative : documentRepresentativeProduct(box.items);
      const fact = representative ? documentProductSourceFact(data, box.sid, representative) : undefined;
      const actualQuantity = actualBoxQuantity(box), fallbackQuantity = group ? actualBoxQuantity(group.box) : actualQuantity;
      const cartonQuantity = validQuantity(fact?.cartonQuantity);
      const mixed = new Set(box.items.map((item) => invoiceProductIdentity(box.sid, item))).size > 1;
      return { box, representative, fact, actualQuantity, cartonQuantity, declaredQuantity: cartonQuantity ?? fallbackQuantity, mixed };
    });
  });
}
