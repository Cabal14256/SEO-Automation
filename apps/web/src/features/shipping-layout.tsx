import type { ReactNode } from 'react';
import type { User } from '../api';
import { AppShell } from '../pages';
import './shipping-workspace.css';

export type ShippingView = 'demands' | 'batches' | 'reports' | 'physical' | 'documents' | 'fulfillment' | 'logistics' | 'customs' | 'archives';
export function ShippingLayout({ user, view, combined = false, children }: { user: User; view: ShippingView; combined?: boolean; children: ReactNode }) {
  return <AppShell user={user} title="发货管理">
    <div className="content-width shipping-workspace" data-view={view}>
      <header className="shipping-workspace-heading"><h1>{combined ? '发货工作台' : '发货管理'}</h1><p>{combined ? '按月份和批次查看货件、商品与箱明细，继续核对或生成发货表。' : '从需求与单据，继续核对物流、申报和批次归档。'}</p></header>
      <div className="shipping-workspace-content">{children}</div>
    </div>
  </AppShell>;
}
