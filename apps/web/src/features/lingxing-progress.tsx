import { useEffect, useId, useState } from 'react';
import './lingxing-progress.css';

export type LingxingProgressStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed';
const labels: Record<LingxingProgressStatus, string> = { queued: '等待开始', running: '正在获取', completed: '本次查询已完成', partial: '本次处理结束，部分结果需处理', failed: '本次查询未完成' };
const elapsedText = (seconds: number) => seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;

/** Percentages use real processed items; an unknown denominator stays indeterminate. */
export function LingxingProgress({ label, status, processed, total, detail, startedAt }: {
  label: string; status: LingxingProgressStatus; processed?: number; total?: number; detail?: string; startedAt?: number | string;
}) {
  const id = useId();
  const [mountedAt] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  const running = status === 'queued' || status === 'running';
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);
  const timestamp = typeof startedAt === 'number' ? startedAt : startedAt ? Date.parse(startedAt) : mountedAt;
  const seconds = Math.max(0, Math.floor((now - (Number.isFinite(timestamp) ? timestamp : mountedAt)) / 1000));
  const known = Number.isFinite(total) && total! > 0 && Number.isFinite(processed) && processed! >= 0;
  const count = known ? Math.min(total!, processed!) : undefined;
  const percentage = status === 'queued' ? undefined : known ? Math.floor(count! / total! * 100) : status === 'completed' || status === 'partial' ? 100 : undefined;
  const indeterminate = running && percentage === undefined;
  const valueText = [labels[status], percentage !== undefined ? `${percentage}%` : '', known ? `已处理 ${count} / ${total}` : '', detail || ''].filter(Boolean).join('，');
  return <section className="lingxing-progress" data-status={status} aria-label={`${label}进度`}>
    <div className="lingxing-progress-heading"><strong id={`${id}-label`}>{label}</strong><span>{percentage !== undefined ? `${percentage}%` : labels[status]}</span></div>
    <div className="lingxing-progress-track" role="progressbar" aria-labelledby={`${id}-label`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage} aria-valuetext={valueText} data-status={status} data-indeterminate={indeterminate}>
      <span className="lingxing-progress-fill" style={{ width: percentage === undefined ? indeterminate ? '35%' : '0%' : `${percentage}%` }} />
    </div>
    <div className="lingxing-progress-description"><p role="status">{labels[status]}{known && ` · 已处理 ${count} / ${total}`}{detail && ` · ${detail}`}</p>{running && <span aria-live="off">已用 {elapsedText(seconds)}</span>}</div>
  </section>;
}
