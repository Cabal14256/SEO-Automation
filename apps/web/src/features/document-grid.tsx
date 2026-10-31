import type { ReactNode } from 'react';
import { PersistentGridScope } from '../components/ui/persistent-data-grid';
export { PersistentDataGrid as DocumentDataGrid, usePersistentGridPreferences as useDocumentGridPreferences, usePersistentFiltersExpanded as useDocumentFiltersExpanded } from '../components/ui/persistent-data-grid';
export type { PersistentGridPreferences as DocumentGridPreferences, GridPageSize as DocumentPageSize } from '../components/ui/persistent-data-grid';
export function DocumentGridScope({ userId, children }: { userId: string; children: ReactNode }) {
  return <PersistentGridScope namespace="documents" userId={userId}>{children}</PersistentGridScope>;
}
