// Synthetic data only. Never evidence that a company account has API access.
import { PATHS } from './probe.mjs';

export const demoConfig = {
  startDate: '2026-10-01', endDate: '2026-11-01',
  shipments: [{ sid: 1, shipmentConfirmationId: 'FBADEMO001', sampleType: '模拟 STA 多箱混装' }],
};

export function fixture() {
  const item = { msku: 'DEMO-A', fnsku: 'XDEMOA', sku: 'SKU-A', productName: '模拟商品 A' };
  const other = { msku: 'DEMO-B', fnsku: 'XDEMOB', sku: 'SKU-B', productName: '模拟商品 B' };
  const target = demoConfig.shipments[0];
  const seller = { sid: 1, name: '模拟美国店铺', country: '美国', status: 1 };
  const listing = { sid: 1, shipment_id: target.shipmentConfirmationId, sta_shipment_id: 'sh-demo-1', is_sta: 1,
    destination_fulfillment_center_id: 'DEMO-FC', reference_id: 'DEMO-REF',
    item_list: [{ ...item, quantity_shipped: 5, init_quantity_shipped: 5, quantity_shipped_local: 0, quantity_received: 0 },
      { ...other, quantity_shipped: 1, init_quantity_shipped: 1, quantity_shipped_local: 0, quantity_received: 0 }] };
  const detail = { code: 0, data: { shipmentList: [{ ...target, warehouseId: 'DEMO-FC', amazonReferenceId: 'DEMO-REF',
    shippingAddress: { addressLine1: 'DEMO ADDRESS' }, shipingTime: '2026-10-16', alphaCode: 'DEMO',
    itemList: [{ ...item, quantity: 5 }, { ...other, quantity: 1 }] }] } };
  const dimensions = { weight: 2, weightUnit: 'KG', length: 20, width: 15, height: 10, lengthUnit: 'CM' };
  const boxes = { code: 0, data: { shipmentList: [{ shipmentId: 'sh-demo-1', shipmentPackingList: [
    { ...dimensions, boxId: 'DEMO-BOX1', total: 4, productList: [{ ...item, quantityInBox: 3 }, { ...other, quantityInBox: 1 }] },
    { ...dimensions, boxId: 'DEMO-BOX2', total: 2, productList: [{ ...item, quantityInBox: 2 }] },
  ] }] } };
  return { target, seller, listing, listComplete: true, detail, boxes };
}

export async function demoFetch(input, options) {
  const url = new URL(input);
  const data = fixture();
  let response;
  switch (url.pathname) {
    case PATHS.sellers: response = { code: 0, data: [data.seller] }; break;
    case PATHS.list: {
      const body = JSON.parse(options.body);
      response = { code: 0, total: 1, data: { list: body.offset === 0 ? [data.listing] : [] } };
      break;
    }
    case PATHS.detail: response = data.detail; break;
    case PATHS.boxes: response = data.boxes; break;
    default: throw new Error('模拟模式不支持此接口');
  }
  return new Response(JSON.stringify(response), { status: 200 });
}
