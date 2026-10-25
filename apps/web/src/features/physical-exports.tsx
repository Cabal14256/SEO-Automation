import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, FileSpreadsheet, History, RefreshCw } from 'lucide-react';
import type { PhysicalExportReference } from '@scm/contracts';
import { ApiError } from '../api';
import { Button, IconButton } from '../components/ui/button';
import { batchApi } from './batch-api';
import { BatchTable, downloadBlob, QueryError, timestamp } from './batch-shared';
import { ImportDialog } from './import-dialog';
import { physicalApi } from './physical-api';
import { usePhysicalAction } from './physical-shared';
import './batch-physical.css';

const statusLabels: Record<string, string> = { queued: '排队中', running: '生成中', completed: '已生成', failed: '失败', stale: '版本已过期' };

export function usePhysicalExports({ references, subBatchId, active = true, onConflict }: {
  references: PhysicalExportReference[]; subBatchId?: string; active?: boolean; onConflict?: () => Promise<unknown>;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const client = useQueryClient();
  const action = usePhysicalAction(`exports:${subBatchId ?? 'all'}`);
  const history = useQuery({ queryKey: ['physical-exports', subBatchId], queryFn: () => physicalApi.exports(subBatchId), enabled: active && historyOpen, retry: false,
    refetchInterval: (query) => active && historyOpen && query.state.data?.some((record) => record.status === 'queued' || record.status === 'running') ? 1500 : false });
  const feedback = conflict ? <p className="form-note error-note" role="alert">实物确认或来源版本已变化。已刷新当前范围，请重新勾选后生成。</p> : action.feedback;
  const generate = async () => {
    if (action.busy || references.length === 0 || references.length > 500) return;
    setConflict(false);
    const result = await action.run(JSON.stringify(['physical-export', references]), async (operationId) => {
      try { return await physicalApi.export({ operationId, references }); }
      catch (error) {
        if (error instanceof ApiError && (error.status === 409 || error.status === 422 || error.status === 404)) {
          setConflict(true);
          await onConflict?.();
        }
        throw error;
      }
    }, '实物箱明细导出已受理，请在生成记录中下载。');
    if (result) {
      setHistoryOpen(true);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['sub-batch'] }), client.invalidateQueries({ queryKey: ['batches'] }),
        client.invalidateQueries({ queryKey: ['physical-workspace'] }),
      ]);
    }
  };
  const historyDialog = createPortal(<ImportDialog open={active && historyOpen} title="实物箱明细导出记录" close={() => setHistoryOpen(false)} wide>
      <div className="batch-report-history-heading"><p className="mapping-help">记录独立的 M2 / M3 确认版本。旧文件保留原内容，过期状态单独显示。</p><IconButton type="button" icon={RefreshCw} label="刷新实物导出记录" loading={history.isFetching} onClick={() => void history.refetch()} /></div>
      {feedback}
      {history.isPending ? <p className="list-state">正在读取实物导出历史…</p> : history.isError ? <QueryError error={history.error} retry={() => void history.refetch()} /> : history.data.length === 0 ? <p className="list-state">尚无实物箱明细导出记录。</p> : <BatchTable label="实物箱明细导出历史" headers={['创建时间 / 范围', '状态 / 箱数', 'M2 / M3 确认版本', '下载 / 错误']}>{history.data.map((record) => <tr key={record.id}><td>{timestamp(record.createdAt)}<small className="mapping-subtext">{record.references.length} 组</small></td><td>{statusLabels[record.status]} · {record.boxCount} 箱{!record.valid && <small className="mapping-subtext warning-note">{record.invalidReason || '历史版本'}</small>}</td><td>{record.references.map((ref) => <div key={ref.groupId}><small className="mapping-subtext">M2 {ref.m2ConfirmationId}</small><small className="mapping-subtext">M3 v{ref.m3Version} · {ref.physicalConfirmationId}</small></div>)}</td><td>{record.fileId && <IconButton type="button" icon={Download} label="下载实物箱明细 XLSX" description={timestamp(record.createdAt)} disabled={action.busy} loading={action.pendingKey === `download-${record.id}`} onClick={() => void action.run(`download-${record.id}`, () => downloadBlob(batchApi.download(record.fileId!), `实物箱明细-${record.id}.xlsx`), '实物箱明细下载已开始。')} />}{record.error && <p className="error-note">{record.error}</p>}</td></tr>)}</BatchTable>}
    </ImportDialog>, document.body);
  return { busy: action.busy, generate, openHistory: () => setHistoryOpen(true), feedback: !historyOpen && feedback, historyDialog };
}

export function PhysicalExports({ subBatchId, active = true }: { subBatchId: string; active?: boolean }) {
  const review = useQuery({ queryKey: ['physical-review', subBatchId], queryFn: () => physicalApi.current(subBatchId), enabled: active, retry: false, refetchInterval: active ? 3000 : false });
  const confirmation = review.data?.confirmation;
  const references: PhysicalExportReference[] = review.data?.valid && review.data.canExport && confirmation && !review.isError ? [{
    groupId: subBatchId, m2ConfirmationId: confirmation.m2ConfirmationId, physicalConfirmationId: confirmation.id,
    m3Version: confirmation.m3Version, sourceFingerprint: confirmation.sourceFingerprint,
  }] : [];
  const exports = usePhysicalExports({ references, subBatchId, active, onConflict: () => review.refetch() });
  return <section className="physical-exports" aria-label="实物箱明细导出">
    <h3>实物箱明细 XLSX</h3>
    <p className="mapping-help">导出当前制表组已确认版本的 KG / CM 数值。</p>
    <div className="physical-actions">
      <Button type="button" icon={FileSpreadsheet} disabled={exports.busy || review.isFetching || references.length === 0} onClick={() => void exports.generate()}>生成实物箱明细 XLSX</Button>
      <Button type="button" icon={History} onClick={exports.openHistory}>生成记录</Button>
      {!review.isFetching && references.length === 0 && <span className="mapping-help">完成有效的整组实物确认后可生成。</span>}
    </div>
    {review.isError && <QueryError error={review.error} retry={() => void review.refetch()} />}
    {exports.feedback}{exports.historyDialog}
  </section>;
}
