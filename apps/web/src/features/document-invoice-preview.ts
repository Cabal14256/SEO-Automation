import { documentBoxes, documentProductSourceFact, documentRepresentativeProduct, type DocumentRevisionData } from '@scm/contracts';

export const invoiceProductIdentity = (sid: number, item: { msku: string; fnsku: string; sku: string }) => JSON.stringify([sid, item.msku, item.fnsku, item.sku]);

const validQuantity = (value: string | null | undefined): number | null => {
  if (!value || !/^\d+$/.test(value)) return null;
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null;
};

export function invoiceBoxPreview(data: DocumentRevisionData, fields = data.fields) {
  return data.members.flatMap((member) => documentBoxes(member, fields).map((box) => {
    const representative = documentRepresentativeProduct(box.items);
    const fact = representative ? documentProductSourceFact(data, box.sid, representative) : undefined;
    const quantities = box.items.map((item) => validQuantity(item.quantity));
    const total = quantities.reduce<number>((sum, quantity) => sum + (quantity ?? 0), 0);
    const actualQuantity = quantities.every((quantity) => quantity !== null) && Number.isSafeInteger(total) && total > 0 ? total : null;
    const cartonQuantity = validQuantity(fact?.cartonQuantity);
    const mixed = new Set(box.items.map((item) => invoiceProductIdentity(box.sid, item))).size > 1;
    return { box, representative, fact, actualQuantity, cartonQuantity, declaredQuantity: cartonQuantity ?? actualQuantity, mixed };
  }));
}
