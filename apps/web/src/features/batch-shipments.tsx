import { useState } from 'react';
import { ChevronUp, Download, Pencil, Plus, RotateCcw, Save, Trash2, Upload } from 'lucide-react';
import { shipmentDataSchema, type ShipmentData, type ShipmentRevision, type SubBatchDetail, type DemandRecord, type ShipmentBox } from '@scm/contracts';
import { Button, IconButton } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Combobox } from '../components/ui/combobox';
import { SelectField } from '../components/ui/select';
import { batchApi } from './batch-api';
import { BatchPanel, BatchTable, downloadBlob, newOperation, timestamp, useBatchAction } from './batch-shared';

const productKey = (item: { msku: string; fnsku: string; sku: string }) => JSON.stringify([item.msku, item.fnsku, item.sku]);
const sourceNames = { lingxing: '领星查询', manual: '人工补录', xlsx: 'XLSX 补录' };
export function BatchShipments({ detail, initialDemandId }: { detail: SubBatchDetail; initialDemandId?: string }) {
  const [chosenId, setChosenId] = useState(initialDemandId ?? detail.members[0]?.id ?? '');
  const [editing, setEditing] = useState(false);
  const demand = detail.members.find((member) => member.id === chosenId) ?? detail.members[0];
  const revision = detail.shipments.find((shipment) => shipment.demandId === demand?.id)?.revision ?? null;
  const locked = detail.group.status === 'frozen' || detail.group.status === 'superseded';
  return <BatchPanel title="商品、逐箱数量与差异处理" help="详情申报量作为主数量；箱内明细逐商品求和。列表当前/初始申报、本地已发货和接收量独立保留，接收差异不修改准备量。">
    <div className="batch-form"><div className="field"><label htmlFor="shipment-demand">选择货件</label><Combobox id="shipment-demand" value={demand?.id ?? ''} onValueChange={(value) => { setChosenId(value); setEditing(false); }} searchPlaceholder="搜索 FBA、店铺或 sid…" options={detail.members.map((member) => ({ value: member.id, label: `${member.snapshot.fba} · ${member.snapshot.shop}`, keywords: [member.snapshot.fba, member.snapshot.shop, String(member.snapshot.sid)] }))} /></div><Button icon={editing ? ChevronUp : Pencil} aria-expanded={editing} disabled={locked || !demand} onClick={() => setEditing(!editing)}>{editing ? '收起人工编辑' : revision ? '人工更正商品 / 逐箱数据' : '人工补录商品 / 逐箱数据'}</Button></div>
    {demand && <>
      <p className="mapping-help">sid {demand.snapshot.sid} · {demand.snapshot.fba} · 需求 v{demand.version}</p>
      {revision ? <><p className="mapping-help">{sourceNames[revision.source]} · 商品数据 v{revision.version} · 采集 / 补录 {timestamp(revision.data.observedAt)} · {revision.data.isSta === true ? 'STA' : revision.data.isSta === false ? '非 STA' : '类型待确认'} · 计划 {revision.data.staPlanId || '未返回'}</p>
        <BatchTable label="多口径商品数量" headers={['商品身份 / 品名', '详情申报量（主数量）', '逐箱合计', '当前 / 初始申报', '本地已发货 / 接收', '数量差异']}>{revision.data.items.map((item, index) => {
          const entries = revision.data.boxes.flatMap((box) => box.items.filter((entry) => productKey(entry) === productKey(item)));
          const packed = revision.data.boxes.length === 0 || revision.data.boxes.some((box) => box.items.length === 0) || entries.some((entry) => entry.quantity === null || !/^\d+$/.test(entry.quantity)) ? null : entries.reduce((sum, entry) => sum + BigInt(entry.quantity!), 0n);
          const quantity = item.quantity !== null && /^\d+$/.test(item.quantity) ? BigInt(item.quantity) : null;
          return <tr key={`${productKey(item)}-${index}`}><td><strong>{item.msku}</strong><small className="mapping-subtext">{item.fnsku} / {item.sku}</small><small className="mapping-subtext">{item.name || '缺品名'}</small></td><td>{item.quantity ?? '缺失'}</td><td>{packed === null ? '缺失 / 无效' : String(packed)}</td><td>{item.listQuantity ?? '缺失'} / {item.initialDeclaredQuantity ?? '缺失'}</td><td>{item.localShippedQuantity ?? '缺失'} / {item.receivedQuantity ?? '缺失'}</td><td className={quantity !== null && packed === quantity ? 'success-note' : 'error-note'}>{quantity === null || packed === null ? '无法校验' : packed === quantity ? '逐箱一致' : `逐箱差额 ${packed - quantity}`}</td></tr>;
        })}</BatchTable>
        <BatchTable label="货件逐箱明细" headers={['确认顺序 / 箱名', '箱标识', '商品身份', '箱内数量', '登记重量 / 尺寸']}>{revision.data.boxes.flatMap((box) => box.items.length > 0 ? box.items.map((item, index) => <tr key={`${box.id}-${index}`}><td>{box.order ?? '待确认'} · {box.name || '无箱名'}</td><td><small className="mapping-subtext">内部 {box.id}</small><small className="mapping-subtext">平台 {box.externalBoxId || '—'} · package {box.packageId || '—'} · local {box.localBoxId || '—'}</small></td><td>{item.msku}<small className="mapping-subtext">{item.fnsku} / {item.sku}</small></td><td>{item.quantity ?? '缺失'}</td><td>{box.weight ?? '缺失'} {box.weightUnit ?? ''}<small className="mapping-subtext">{box.length ?? '—'} × {box.width ?? '—'} × {box.height ?? '—'} {box.dimensionUnit ?? ''}</small></td></tr>) : [<tr key={box.id}><td>{box.name || '无箱名'}</td><td>{box.id}</td><td colSpan={3} className="error-note">空装箱，需补录或人工核对</td></tr>])}</BatchTable>
        <BoxMapping key={`${demand.id}-${revision.id}`} detail={detail} demand={demand} revision={revision} />
        <QuantityDecisions key={`decisions-${demand.id}`} detail={detail} revision={revision} />
      </> : <p className="list-state">尚无可用商品 / 箱数据。可同步领星，也可通过 XLSX 或人工补录恢复。</p>}
      <IntakeUpload detail={detail} demand={demand} />
      {editing && <ManualShipment key={`manual-${demand.id}`} detail={detail} demand={demand} revision={revision} />}
    </>}
  </BatchPanel>;
}

function BoxMapping({ detail, demand, revision }: { detail: SubBatchDetail; demand: DemandRecord; revision: ShipmentRevision }) {
  const action = useBatchAction();
  const numeric = (value: string | null) => value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const sorted = [...revision.data.boxes].sort((a, b) => (numeric(a.localBoxId) ?? Number.MAX_SAFE_INTEGER) - (numeric(b.localBoxId) ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
  const [orders, setOrders] = useState<Record<string, number>>(() => Object.fromEntries(sorted.map((box, index) => [box.id, box.order ?? index + 1])));
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [accepted, setAccepted] = useState(false);
  const oldBoxes = detail.confirmation?.snapshot.shipments.find((shipment) => shipment.demandId === demand.id)?.revision.data.boxes ?? [];
  const locked = detail.group.status === 'frozen' || detail.group.status === 'superseded';
  return <div className="batch-subsection"><h3>箱序与内部身份映射</h3><p className="mapping-help">首次建议按 localBoxId 数字排序，缺号或重复须人工核对。调整顺序不会把平台箱名当作内部ID。旧确认箱仅在可靠对应后选择，新增箱保持“新增内部箱”。</p>
    <BatchTable label="箱序及身份确认" headers={['平台箱名 / localBoxId', '确认箱序', '对应旧确认箱']}>{sorted.map((box) => <tr key={box.id}><td>{box.name || '无箱名'}<small className="mapping-subtext">localBoxId {box.localBoxId || '缺失'} · {box.id}</small></td><td><Input type="number" min={1} max={sorted.length} value={orders[box.id] ?? ''} disabled={locked} aria-label={`${box.name || box.id} 的确认顺序`} onChange={(event) => { setOrders((current) => ({ ...current, [box.id]: Number(event.target.value) })); setAccepted(false); }} /></td><td><Combobox id={`old-box-${demand.id}-${box.id}`} disabled={locked} aria-label={`${box.name || box.id} 对应的旧确认箱`} value={mapping[box.id] ?? (oldBoxes.some((old) => old.id === box.id) ? box.id : '')} onValueChange={(value) => { setMapping((current) => ({ ...current, [box.id]: value })); setAccepted(false); }} searchPlaceholder="搜索旧箱名称或编号…" options={[{ value: '', label: '新增内部箱 / 无旧箱' }, ...oldBoxes.map((old) => ({ value: old.id, label: `${old.name || old.id} · 原顺序 ${old.order ?? '未确认'}`, keywords: [old.name ?? '', old.id, old.localBoxId ?? ''] }))]} /></td></tr>)}</BatchTable>
    <div className="batch-form"><div className="field"><label htmlFor={`box-reason-${demand.id}`}>箱序 / 映射确认说明</label><Input id={`box-reason-${demand.id}`} value={reason} maxLength={1000} onChange={(event) => setReason(event.target.value)} disabled={locked} /></div><Button icon={Save} loading={action.busy} disabled={locked || action.busy || !accepted || !reason.trim() || sorted.length === 0} onClick={() => action.run(JSON.stringify(['mapping', detail.group.version, revision.version, orders, mapping, reason]), (operationId) => batchApi.groupAction(detail.group.id, 'box-mapping', { operationId, expectedVersion: detail.group.version, reason, demandId: demand.id, expectedShipmentVersion: revision.version, mappings: sorted.map((box) => ({ boxId: box.id, existingBoxId: mapping[box.id] ?? (oldBoxes.some((old) => old.id === box.id) ? box.id : null), order: orders[box.id] })) }), '箱序及身份映射已保存，需按新版本重新校验确认。')}>保存人工箱序 / 映射</Button></div>
    <CheckBox accepted={accepted} setAccepted={setAccepted} locked={locked} text="已逐箱核对平台编号、内部身份和顺序。" />{action.feedback}
  </div>;
}

function QuantityDecisions({ detail, revision }: { detail: SubBatchDetail; revision: ShipmentRevision }) {
  const relevant = detail.issues.filter((issue) => issue.demandId === revision.demandId);
  const action = useBatchAction();
  const [issueCode, setIssueCode] = useState('');
  const [note, setNote] = useState('');
  const locked = detail.group.status === 'frozen' || detail.group.status === 'superseded';
  return <div className="batch-subsection"><h3>差异与人工决定</h3>{relevant.length > 0 ? <ul className="import-issues">{relevant.map((issue, index) => <li key={`${issue.code}-${index}`} className={issue.severity === 'error' ? 'error-note' : 'warning-note'}>{issue.message}（{issue.code}）</li>)}</ul> : <p className="mapping-help">此票当前没有服务端校验差异。</p>}
      <div className="batch-form"><div className="field"><label htmlFor={`decision-code-${revision.demandId}`}>需要记录决定的差异</label><SelectField id={`decision-code-${revision.demandId}`} value={issueCode} disabled={locked} onValueChange={setIssueCode} options={[{ value: '', label: '选择可人工确认的列表口径冲突' }, ...[...new Set(relevant.filter((issue) => issue.code === 'LIST_QUANTITY_MISMATCH').map((issue) => issue.code))].map((value) => ({ value, label: '列表与详情冲突：保留详情主口径' }))]} /></div><div className="field"><label htmlFor={`decision-note-${revision.demandId}`}>核对结果 / 处理依据</label><Input id={`decision-note-${revision.demandId}`} value={note} disabled={locked} maxLength={1000} onChange={(event) => setNote(event.target.value)} /></div><Button icon={Save} loading={action.busy} disabled={locked || action.busy || !issueCode || !note.trim()} onClick={() => action.run(JSON.stringify(['decision', detail.group.version, revision.version, issueCode, note]), (operationId) => batchApi.groupAction(detail.group.id, 'decisions', { operationId, expectedVersion: detail.group.version, reason: note, demandId: revision.demandId, expectedShipmentVersion: revision.version, issueCode, note }), '人工决定已记录，服务端重新计算剩余异常。')}>保存人工决定</Button></div><p className="mapping-help">人工决定不跳过缺身份、重复和逐箱数量守恒。需要调整商品或箱数据时请使用人工更正，原始快照保留。</p>{action.feedback}
  </div>;
}

function IntakeUpload({ detail, demand }: { detail: SubBatchDetail; demand: DemandRecord }) {
  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const action = useBatchAction();
  const locked = detail.group.status === 'frozen' || detail.group.status === 'superseded';
  return <div className="batch-subsection"><h3>XLSX 回退补录</h3><p className="mapping-help">下载固定模板，填写商品和逐箱明细两张表。上传将生成新的本地候选版本，原API快照与原确认保留。</p><IconButton icon={Download} label="下载 XLSX 补录模板" loading={action.pendingKey === 'intake-template'} disabled={action.busy} onClick={() => action.run('intake-template', () => downloadBlob(batchApi.template(), '商品与逐箱补录模板.xlsx'), '补录模板下载已开始。')} />
    <form className="batch-form" onSubmit={(event) => { event.preventDefault(); if (!file) { setError('请先选择补录文件。'); return; } if (!file.name.toLowerCase().endsWith('.xlsx') || file.size === 0 || file.size > 10 * 1024 * 1024) { setError('请选择有内容、大小不超过10MB的 .xlsx 文件。'); return; } setError(''); action.run(JSON.stringify(['intake', demand.id, detail.group.version, file.name, file.size, file.lastModified, reason]), (operationId) => batchApi.intake(file, { operationId, subBatchId: detail.group.id, demandId: demand.id, expectedVersion: detail.group.version, reason }), '补录已发布为新候选版本，请重新核对。'); }}>
      <div className="field"><label htmlFor={`intake-file-${demand.id}`}>商品与逐箱补录文件</label><input id={`intake-file-${demand.id}`} type="file" accept=".xlsx" disabled={locked || action.busy} onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></div><div className="field"><label htmlFor={`intake-reason-${demand.id}`}>补录来源与原因（必填）</label><Input id={`intake-reason-${demand.id}`} value={reason} maxLength={1000} disabled={locked} onChange={(event) => setReason(event.target.value)} /></div><Button icon={Upload} loading={action.pendingKey?.startsWith('["intake",')} type="submit" disabled={locked || action.busy || !reason.trim()}>上传并发布候选</Button>
    </form>{error && <p className="form-note error-note" role="alert">{error}</p>}{action.feedback}
  </div>;
}

type DraftProduct = { id: string; msku: string; fnsku: string; sku: string; name: string; quantity: string; listQuantity: string; initialDeclaredQuantity: string; localShippedQuantity: string; receivedQuantity: string; expiration?: string | null; prepOwner?: string | null; labelOwner?: string | null };
type DraftBox = { id: string; externalBoxId: string; packageId: string; localBoxId: string; name: string; order: string; weight: string; weightUnit: string; length: string; width: string; height: string; dimensionUnit: string; quantities: Record<string, string>; extraItems: (ShipmentBox['items'][number] & { entryId: string })[] };
function makeDraft(data: ShipmentData | null) {
  const products: DraftProduct[] = data?.items.map((item) => ({ id: newOperation(), msku: item.msku, fnsku: item.fnsku, sku: item.sku, name: item.name ?? '', quantity: item.quantity ?? '', listQuantity: item.listQuantity ?? '', initialDeclaredQuantity: item.initialDeclaredQuantity ?? '', localShippedQuantity: item.localShippedQuantity ?? '', receivedQuantity: item.receivedQuantity ?? '', expiration: item.expiration, prepOwner: item.prepOwner, labelOwner: item.labelOwner })) ?? [];
  const boxes: DraftBox[] = data?.boxes.map((box) => {
    const seen = new Set<string>();
    const extraItems = box.items.filter((item) => { const key = productKey(item); const extra = seen.has(key) || !products.some((product) => productKey(product) === key); seen.add(key); return extra; }).map((item) => ({ ...item, entryId: newOperation() }));
    return { id: box.id, externalBoxId: box.externalBoxId ?? '', packageId: box.packageId ?? '', localBoxId: box.localBoxId ?? '', name: box.name ?? '', order: box.order === null ? '' : String(box.order), weight: box.weight ?? '', weightUnit: box.weightUnit ?? '', length: box.length ?? '', width: box.width ?? '', height: box.height ?? '', dimensionUnit: box.dimensionUnit ?? '', quantities: Object.fromEntries(products.map((product) => { const entry = box.items.find((item) => productKey(item) === productKey(product)); return [product.id, entry ? entry.quantity ?? '' : '0']; })), extraItems };
  }) ?? [];
  return { products, boxes };
}

function ManualShipment({ detail, demand, revision }: { detail: SubBatchDetail; demand: DemandRecord; revision: ShipmentRevision | null }) {
  const [draft, setDraft] = useState(() => makeDraft(revision?.data ?? null));
  const [baseline, setBaseline] = useState({ groupVersion: detail.group.version, demandVersion: demand.version, revisionId: revision?.id ?? null, observedAt: new Date().toISOString() });
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const action = useBatchAction();
  const stale = baseline.groupVersion !== detail.group.version || baseline.demandVersion !== demand.version || baseline.revisionId !== (revision?.id ?? null);
  const locked = detail.group.status === 'frozen' || detail.group.status === 'superseded';
  const updateProduct = (id: string, field: keyof DraftProduct, value: string) => setDraft((current) => ({ ...current, products: current.products.map((product) => product.id === id ? { ...product, [field]: value } : product) }));
  const updateBox = (id: string, field: Exclude<keyof DraftBox, 'quantities' | 'extraItems'>, value: string) => setDraft((current) => ({ ...current, boxes: current.boxes.map((box) => box.id === id ? { ...box, [field]: value } : box) }));
  const text = (value: string) => value.trim() || null;
  const save = () => {
    const data = { sid: demand.snapshot.sid, fba: demand.snapshot.fba, isSta: revision?.data.isSta ?? null, staPlanId: revision?.data.staPlanId ?? null, shipmentStatus: revision?.data.shipmentStatus ?? null, observedAt: baseline.observedAt, issues: [],
      items: draft.products.map((product) => ({ msku: product.msku, fnsku: product.fnsku, sku: product.sku, name: text(product.name), quantity: text(product.quantity), listQuantity: text(product.listQuantity), initialDeclaredQuantity: text(product.initialDeclaredQuantity), localShippedQuantity: text(product.localShippedQuantity), receivedQuantity: text(product.receivedQuantity), expiration: product.expiration, prepOwner: product.prepOwner, labelOwner: product.labelOwner })),
      boxes: draft.boxes.map((box) => ({ id: box.id, externalBoxId: text(box.externalBoxId), packageId: text(box.packageId), localBoxId: text(box.localBoxId), name: text(box.name), order: box.order ? Number(box.order) : null, weight: text(box.weight), weightUnit: text(box.weightUnit), length: text(box.length), width: text(box.width), height: text(box.height), dimensionUnit: text(box.dimensionUnit), items: [...draft.products.filter((product) => box.quantities[product.id] !== '0').map((product) => ({ ...revision?.data.boxes.find((old) => old.id === box.id)?.items.find((item) => productKey(item) === productKey(product)), msku: product.msku, fnsku: product.fnsku, sku: product.sku, quantity: text(box.quantities[product.id] ?? '') })), ...box.extraItems.map((item) => ({ msku: item.msku, fnsku: item.fnsku, sku: item.sku, quantity: item.quantity, expiration: item.expiration, prepOwner: item.prepOwner, labelOwner: item.labelOwner }))] })),
    };
    const parsed = shipmentDataSchema.safeParse(data);
    if (!parsed.success) { setError(parsed.error.issues.map((issue) => `${issue.path.join('.')}：${issue.message}`).join('；')); return; }
    setError(''); action.run(JSON.stringify(['manual', baseline, draft, reason]), (operationId) => batchApi.manual(detail.group.id, demand.id, { operationId, expectedVersion: baseline.groupVersion, expectedDemandVersion: baseline.demandVersion, reason, data: parsed.data }), '人工候选版本已保存，请重新核对数量并确认箱序。');
  };
  return <div className="batch-subsection batch-manual"><h3>人工商品 / 逐箱编辑</h3><p className="mapping-help">每行商品必须保留 MSKU、FNSKU、SKU。逐箱的显式 0 表示此箱没有该商品，空值表示尚未补齐。来源和修改原因写入新版本。</p>
    {stale && <p className="permission-note warning-note">当前草稿的数据版本已变化，内容仍保留。请核对后重新载入，再保存。<Button icon={RotateCcw} onClick={() => { setDraft(makeDraft(revision?.data ?? null)); setBaseline({ groupVersion: detail.group.version, demandVersion: demand.version, revisionId: revision?.id ?? null, observedAt: new Date().toISOString() }); }}>重新载入当前数据</Button></p>}
    <BatchTable label="人工商品编辑" headers={['MSKU', 'FNSKU', 'SKU', '品名', '详情口径数量', '当前申报', '初始申报', '本地已发货', '接收量', '操作']}>{draft.products.map((product, index) => <tr key={product.id}>{(['msku', 'fnsku', 'sku', 'name', 'quantity', 'listQuantity', 'initialDeclaredQuantity', 'localShippedQuantity', 'receivedQuantity'] as const).map((field) => <td key={field}><Input aria-label={`商品${index + 1} ${field}`} value={product[field]} disabled={locked} onChange={(event) => updateProduct(product.id, field, event.target.value)} /></td>)}<td><Button icon={Trash2} disabled={locked} onClick={() => setDraft((current) => ({ ...current, products: current.products.filter((item) => item.id !== product.id) }))}>删除商品行</Button></td></tr>)}</BatchTable>
    <Button icon={Plus} disabled={locked} onClick={() => setDraft((current) => ({ ...current, products: [...current.products, { id: newOperation(), msku: '', fnsku: '', sku: '', name: '', quantity: '', listQuantity: '', initialDeclaredQuantity: '', localShippedQuantity: '', receivedQuantity: '' }] }))}>添加商品行</Button>
    <BatchTable label="人工箱及箱内数量编辑" headers={['箱名', 'localBoxId', '平台箱ID', 'packageId', '顺序', ...draft.products.map((product, index) => `${product.sku || `商品${index + 1}`} 箱内数量`), '重量 / 单位', '长 / 宽 / 高 / 单位', '操作']}>{draft.boxes.map((box, index) => <tr key={box.id}>{(['name', 'localBoxId', 'externalBoxId', 'packageId', 'order'] as const).map((field) => <td key={field}><Input aria-label={`箱${index + 1} ${field}`} value={box[field]} disabled={locked} onChange={(event) => updateBox(box.id, field, event.target.value)} /></td>)}{draft.products.map((product) => <td key={product.id}><Input aria-label={`箱${index + 1} ${product.sku || product.msku || '商品'} 数量`} inputMode="numeric" value={box.quantities[product.id] ?? ''} disabled={locked} onChange={(event) => setDraft((current) => ({ ...current, boxes: current.boxes.map((item) => item.id === box.id ? { ...item, quantities: { ...item.quantities, [product.id]: event.target.value } } : item) }))} /></td>)}<td>{(['weight', 'weightUnit'] as const).map((field) => <Input key={field} aria-label={`箱${index + 1} ${field}`} value={box[field]} disabled={locked} onChange={(event) => updateBox(box.id, field, event.target.value)} />)}</td><td>{(['length', 'width', 'height', 'dimensionUnit'] as const).map((field) => <Input key={field} aria-label={`箱${index + 1} ${field}`} value={box[field]} disabled={locked} onChange={(event) => updateBox(box.id, field, event.target.value)} />)}</td><td><Button icon={Trash2} disabled={locked} onClick={() => setDraft((current) => ({ ...current, boxes: current.boxes.filter((item) => item.id !== box.id) }))}>删除箱</Button></td></tr>)}</BatchTable>
    {draft.boxes.some((box) => box.extraItems.length > 0) && <><p className="form-note warning-note">原候选含重复或未匹配的箱商品记录，以下逐条保留。请明确修正主表、删除重复记录或保留待处理，不会自动去重。</p><BatchTable label="原始重复或未匹配箱商品" headers={['箱名', 'MSKU / FNSKU / SKU', '数量', '明确处理']}>{draft.boxes.flatMap((box) => box.extraItems.map((item) => <tr key={item.entryId}><td>{box.name || box.id}</td><td>{item.msku}<small className="mapping-subtext">{item.fnsku} / {item.sku}</small></td><td>{item.quantity ?? '缺失'}</td><td><Button icon={Trash2} disabled={locked} onClick={() => setDraft((current) => ({ ...current, boxes: current.boxes.map((entry) => entry.id === box.id ? { ...entry, extraItems: entry.extraItems.filter((extra) => extra.entryId !== item.entryId) } : entry) }))}>明确删除此重复 / 未匹配记录</Button></td></tr>))}</BatchTable></>}
    <Button icon={Plus} disabled={locked} onClick={() => setDraft((current) => ({ ...current, boxes: [...current.boxes, { id: newOperation(), externalBoxId: '', packageId: '', localBoxId: '', name: '', order: '', weight: '', weightUnit: '', length: '', width: '', height: '', dimensionUnit: '', quantities: {}, extraItems: [] }] }))}>添加实际箱</Button>
    <div className="batch-form"><div className="field"><label htmlFor={`manual-reason-${demand.id}`}>人工补录来源与原因（必填）</label><Input id={`manual-reason-${demand.id}`} value={reason} disabled={locked} maxLength={1000} onChange={(event) => setReason(event.target.value)} /></div><Button icon={Save} loading={action.busy} variant="primary" disabled={locked || stale || action.busy || !reason.trim() || draft.products.length === 0 || draft.boxes.length === 0} onClick={save}>保存新人工候选版本</Button></div>{error && <p className="form-note error-note" role="alert">{error}</p>}{action.feedback}
  </div>;
}

function CheckBox({ accepted, setAccepted, locked, text }: { accepted: boolean; setAccepted: (accepted: boolean) => void; locked: boolean; text: string }) {
  return <label className="import-check"><input type="checkbox" checked={accepted} disabled={locked} onChange={(event) => setAccepted(event.target.checked)} />{text}</label>;
}
