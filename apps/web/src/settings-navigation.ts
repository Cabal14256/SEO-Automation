import { Files, ListChecks, Store } from 'lucide-react';

export const settingsItems = [
  { to: '/settings/seller-mappings', label: '店铺映射', icon: Store },
  { to: '/settings/document-profiles', label: '单据资料', icon: Files },
  { to: '/settings/seller-export-codes', label: '店铺导出代号', icon: Store },
  { to: '/settings/service-mappings', label: '发票服务映射', icon: ListChecks },
] as const;
