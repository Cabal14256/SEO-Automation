import { Link, Navigate } from '@tanstack/react-router';
import { Files, Store } from 'lucide-react';
import type { ReactNode } from 'react';
import type { User } from '../api';
import { AppShell } from '../pages';
import './settings.css';

export function SettingsRoute() {
  return <Navigate to="/settings/seller-mappings" replace />;
}

export function SettingsLayout({ user, children }: { user: User; children: ReactNode }) {
  return (
    <AppShell user={user} title="设置">
      <div className="content-width settings-page">
        <header className="settings-page-heading"><h1>设置</h1></header>
        <nav className="settings-navigation" aria-label="设置分类">
          <Link to="/settings/seller-mappings" className="settings-navigation-link" activeProps={{ className: 'settings-navigation-link-active', 'aria-current': 'page' }}>
            <Store size={18} aria-hidden="true" /><span>店铺映射</span>
          </Link>
          <Link to="/settings/document-profiles" className="settings-navigation-link" activeProps={{ className: 'settings-navigation-link-active', 'aria-current': 'page' }}>
            <Files size={18} aria-hidden="true" /><span>单据资料</span>
          </Link>
        </nav>
        <div className="settings-content">{children}</div>
      </div>
    </AppShell>
  );
}
