import { Link, Navigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { User } from '../api';
import { AppShell } from '../pages';
import { settingsItems } from '../settings-navigation';
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
          {settingsItems.map(({ to, label, icon: Icon }) => <Link key={to} to={to} className="settings-navigation-link" activeProps={{ className: 'settings-navigation-link-active', 'aria-current': 'page' }}>
            <Icon size={18} aria-hidden="true" /><span>{label}</span>
          </Link>)}
        </nav>
        <div className="settings-content">{children}</div>
      </div>
    </AppShell>
  );
}
