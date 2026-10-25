import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, Navigate, Outlet, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardRoute, LoginRoute, NotFoundPage } from './pages';
import { SellerMappingsRoute } from './features/seller-mappings';
import { SettingsRoute } from './features/settings';
import { DocumentProfilesRoute } from './features/document-profiles';
import { DocumentAddressesRoute } from './features/document-address-settings';
import { ImportsRoute } from './features/imports';
import { BatchesRoute } from './features/batches';
import { ShippingRoute } from './features/shipping-workspace';
import { FinanceRoute } from './features/workflow-workspace';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true },
  },
});

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFoundPage,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardRoute,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginRoute,
});

const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsRoute });
const documentProfilesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings/document-profiles', component: DocumentProfilesRoute,
  validateSearch: (search: Record<string, unknown>): { documentId?: string } => ({ documentId: typeof search.documentId === 'string' && /^[0-9a-f-]{36}$/i.test(search.documentId) ? search.documentId : undefined }),
});
const documentAddressesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings/addresses', component: DocumentAddressesRoute,
  validateSearch: (search: Record<string, unknown>): { documentId?: string; draftId?: string } => ({
    documentId: typeof search.documentId === 'string' && /^[0-9a-f-]{36}$/i.test(search.documentId) ? search.documentId : undefined,
    draftId: typeof search.draftId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(search.draftId) ? search.draftId : undefined,
  }),
});
const sellerMappingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/seller-mappings',
  component: SellerMappingsRoute,
});

const importsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/imports', component: ImportsRoute });
const shippingRoute = createRoute({ getParentRoute: () => rootRoute, path: '/shipping', component: ShippingRoute,
  validateSearch: (search: Record<string, unknown>): { view?: 'demands' | 'batches' | 'reports' | 'physical' | 'documents' | 'fulfillment' | 'logistics' | 'customs' | 'archives'; groupId?: string; documentId?: string; recordId?: string; pool?: 'ungrouped' } => ({
    view: search.view === 'batches' || search.view === 'reports' || search.view === 'physical' || search.view === 'documents' || search.view === 'fulfillment' || search.view === 'logistics' || search.view === 'customs' || search.view === 'archives' ? search.view : 'demands',
    groupId: typeof search.groupId === 'string' && /^[0-9a-f-]{36}$/i.test(search.groupId) ? search.groupId : undefined,
    documentId: typeof search.documentId === 'string' && /^[0-9a-f-]{36}$/i.test(search.documentId) ? search.documentId : undefined,
    recordId: typeof search.recordId === 'string' && /^[0-9a-f-]{36}$/i.test(search.recordId) ? search.recordId : undefined,
    pool: search.pool === 'ungrouped' ? 'ungrouped' : undefined,
  }),
});
const financeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/finance', component: FinanceRoute,
  validateSearch: (search: Record<string, unknown>): { groupId?: string; recordId?: string } => ({
    groupId: typeof search.groupId === 'string' && /^[0-9a-f-]{36}$/i.test(search.groupId) ? search.groupId : undefined,
    recordId: typeof search.recordId === 'string' && /^[0-9a-f-]{36}$/i.test(search.recordId) ? search.recordId : undefined,
  }),
});
const newImportRoute = createRoute({ getParentRoute: () => rootRoute, path: '/imports/new', component: ImportsRoute,
  validateSearch: (search: Record<string, unknown>): { importId?: string; step?: 1 | 2 | 3 | 4 | 5 } => ({
    importId: typeof search.importId === 'string' && /^[0-9a-f-]{36}$/i.test(search.importId) ? search.importId : undefined,
    step: [1, 2, 3, 4, 5].includes(Number(search.step)) ? Number(search.step) as 1 | 2 | 3 | 4 | 5 : undefined,
  }),
});
const importDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: '/imports/$importId', component: ImportsRoute });
const batchSearch = (search: Record<string, unknown>): { groupId?: string; demandId?: string; tab?: string; weekStartDate?: string; wizard?: 'create' | 'process'; stage?: 'members' | 'products' | 'confirmation' | 'exports'; legacyPhysical?: boolean; stageVersion?: 2 } => ({
  groupId: typeof search.groupId === 'string' && /^[0-9a-f-]{36}$/i.test(search.groupId) ? search.groupId : undefined,
  demandId: typeof search.demandId === 'string' && /^[0-9a-f-]{36}$/i.test(search.demandId) ? search.demandId : undefined,
  tab: typeof search.tab === 'string' && ['shipments', 'members', 'confirmation', 'physical', 'reports', 'history'].includes(search.tab) ? search.tab : undefined,
  weekStartDate: typeof search.weekStartDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(search.weekStartDate) ? search.weekStartDate : undefined,
  wizard: search.wizard === 'create' || search.wizard === 'process' ? search.wizard : undefined,
  stage: typeof search.stage === 'string' && ['members', 'products', 'confirmation', 'exports'].includes(search.stage) ? search.stage as 'members' | 'products' | 'confirmation' | 'exports' : ({ 1: 'members', 2: 'products', 3: 'confirmation', 4: 'exports' } as const)[Number(search.step) as 1 | 2 | 3 | 4],
  legacyPhysical: search.stage === 'physical' || search.legacyPhysical === true || search.legacyPhysical === 'true' ? true : undefined,
  stageVersion: search.stageVersion === 2 || search.stageVersion === '2' ? 2 : undefined,
});
const batchesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/batches', component: BatchesRoute, validateSearch: batchSearch });
const newBatchRoute = createRoute({ getParentRoute: () => rootRoute, path: '/batches/new', component: BatchesRoute, validateSearch: batchSearch });
const batchDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: '/batches/$batchId', component: BatchesRoute, validateSearch: batchSearch });
const batchReportsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/batch-reports', component: () => <Navigate to="/shipping" search={{ view: 'reports' }} replace /> });

const router = createRouter({
  routeTree: rootRoute.addChildren([dashboardRoute, loginRoute, settingsRoute, documentProfilesRoute, documentAddressesRoute, sellerMappingsRoute, shippingRoute, financeRoute, importsRoute, newImportRoute, importDetailRoute, batchesRoute, newBatchRoute, batchDetailRoute, batchReportsRoute]),
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
