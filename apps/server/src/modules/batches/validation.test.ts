import { describe, expect, it } from 'vitest';
import type { ShipmentData } from '@scm/contracts';
import { alphabeticPrefix, productKey, validateShipmentData } from './validation.js';

const fixture = (): ShipmentData => ({ sid: 1, fba: 'FBAABC123', observedAt:'2026-10-17T00:00:00Z', issues:[], items:[{msku:'M',fnsku:'F',sku:'S',name:'商品',quantity:'3'}], boxes:[{id:'00000000-0000-4000-8000-000000000001',externalBoxId:'1',packageId:null,localBoxId:'1',name:'箱1',order:1,items:[{msku:'M',fnsku:'F',sku:'S',quantity:'3'}]}] });
describe('batch quantity and identity invariants',()=>{
  it('encodes weekly prefixes through alphabet boundaries',()=>{expect([0,25,26,27,51,52,701,702].map(alphabeticPrefix)).toEqual(['A','Z','AA','AB','AZ','BA','ZZ','AAA']);expect(()=>alphabeticPrefix(-1)).toThrow();});
  it('accepts exact per-product box conservation and legal zero',()=>{const data=fixture();expect(validateShipmentData(data)).toEqual([]);data.items[0]!.quantity='0';data.boxes[0]!.items[0]!.quantity='0';expect(validateShipmentData(data)).toEqual([]);});
  it('keeps absent quantities blocking instead of converting them into zero',()=>{const data=fixture();data.items[0]!.quantity=null;data.boxes[0]!.items[0]!.quantity=null;expect(validateShipmentData(data).map((i)=>i.code)).toEqual(expect.arrayContaining(['PRODUCT_QUANTITY_REQUIRED','BOX_QUANTITY_REQUIRED']));});
  it('requires a product name and prevents unsafe Excel integer conversion',()=>{const data=fixture();data.items[0]!.name=null;data.items[0]!.quantity='9007199254740992';data.boxes[0]!.items[0]!.quantity='9007199254740992';expect(validateShipmentData(data).map((i)=>i.code)).toEqual(expect.arrayContaining(['PRODUCT_NAME_REQUIRED','PRODUCT_QUANTITY_REQUIRED','BOX_QUANTITY_REQUIRED']));});
  it('detects equal grand totals with incorrect product allocation',()=>{const data=fixture();data.items.push({...data.items[0]!,fnsku:'F2',quantity:'2'});data.boxes[0]!.items=[{msku:'M',fnsku:'F',sku:'S',quantity:'2'},{msku:'M',fnsku:'F2',sku:'S',quantity:'3'}];expect(validateShipmentData(data).filter((i)=>i.code==='PACKED_QUANTITY_MISMATCH')).toHaveLength(2);expect(productKey(data.items[0]!)).not.toEqual(productKey(data.items[1]!));});
  it('retains mixed boxes and one product spread over eleven boxes',()=>{const data=fixture();data.items[0]!.quantity='11';data.boxes=Array.from({length:11},(_,index)=>({...data.boxes[0]!,id:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,order:index+1,items:[{...data.boxes[0]!.items[0]!,quantity:'1'}]}));expect(validateShipmentData(data)).toEqual([]);});
  it('separates completed receipt differences from declared/list conflicts',()=>{const data=fixture();data.shipmentStatus='CLOSED';data.items[0]!.receivedQuantity='2';data.items[0]!.listQuantity='4';const issues=validateShipmentData(data);expect(issues.find((i)=>i.code==='RECEIVED_DIFFERENCE')?.severity).toBe('warning');expect(issues.find((i)=>i.code==='LIST_QUANTITY_MISMATCH')?.severity).toBe('error');});
  it.each([undefined, null, 'WORKING', 'SHIPPED', 'DELIVERED', 'CHECKED_IN', 'RECEIVING', 'CANCELLED', 'UNKNOWN'])('suppresses persisted premature receipt notices for %s without mutating the snapshot', (status) => {
    const data = fixture(); data.shipmentStatus = status; data.items[0]!.receivedQuantity = '0';
    data.issues = [{ code: 'RECEIPT_DIFFERENCE', severity: 'warning', message: '旧同步接收差异' }, { code: 'RECEIVED_DIFFERENCE', severity: 'warning', message: '旧校验接收差异' }, { code: 'BOX_MAPPING_REQUIRED', severity: 'error', message: '需要映射' }];
    const before = structuredClone(data), issues = validateShipmentData(data);
    expect(issues.filter((issue) => ['RECEIPT_DIFFERENCE', 'RECEIVED_DIFFERENCE'].includes(issue.code))).toEqual([]);
    expect(issues).toContainEqual(data.issues[2]); expect(data).toEqual(before);
  });
  it('recomputes a single completed receipt warning and removes stale resolved notices', () => {
    const data = fixture(); data.shipmentStatus = 'CLOSED'; data.items[0]!.receivedQuantity = '2';
    data.issues = ['RECEIPT_DIFFERENCE', 'RECEIVED_DIFFERENCE'].map((code) => ({ code, severity: 'warning' as const, message: '历史重复差异' }));
    expect(validateShipmentData(data)).toEqual([expect.objectContaining({ code: 'RECEIVED_DIFFERENCE', severity: 'warning', details: expect.objectContaining({ detail: '3', received: '2' }) })]);
    data.items[0]!.receivedQuantity = '3'; expect(validateShipmentData(data)).toEqual([]);
    data.items[0]!.receivedQuantity = null; expect(validateShipmentData(data)).toEqual([]);
    data.items[0]!.receivedQuantity = '4'; expect(validateShipmentData(data)).toHaveLength(1);
    expect(data.items[0]!.quantity).toBe('3'); expect(data.boxes[0]!.items[0]!.quantity).toBe('3');
  });
  it('blocks duplicate boxes, duplicate products and ambiguous box order',()=>{const data=fixture();data.boxes.push({...data.boxes[0]!});data.boxes[0]!.items.push({...data.boxes[0]!.items[0]!});expect(validateShipmentData(data).map((i)=>i.code)).toEqual(expect.arrayContaining(['DUPLICATE_BOX_ID','BOX_ORDER_REQUIRED','DUPLICATE_BOX_PRODUCT']));});
  it('keeps upstream mapping conflicts blocking',()=>{const data=fixture();data.issues.push({code:'BOX_MAPPING_REQUIRED',severity:'error',message:'需人工映射'});expect(validateShipmentData(data).some((i)=>i.code==='BOX_MAPPING_REQUIRED')).toBe(true);});
});
