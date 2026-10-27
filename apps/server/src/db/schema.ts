import { boolean, bigint, check, date, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { shippingLifecycleColumns } from '../modules/shipping-lifecycle/columns.js';
import { sql } from 'drizzle-orm';
export * from '../modules/batches/schema.js';
export * from '../modules/batches/export-schema.js';
export * from '../modules/physical/schema.js';
export * from '../modules/imports/drafts-schema.js';
export * from '../modules/documents/schema.js';
export * from '../modules/documents/profile-import-schema.js';
export * from '../modules/documents/reference-schema.js';
export * from '../modules/documents/automation-schema.js';
export * from '../modules/workflow/schema.js';
import type { DemandSnapshot, ImportCommitResult, ImportCounts, ImportIssue, ImportNormalizedRow, ImportPreviewPayload, ImportRawCell, ImportSellerConfirmation, ImportSheet, ImportSourceLocation } from '@scm/contracts';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// Better Auth core tables and the admin plugin's user/session fields.
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
  role: text('role').notNull().default('admin'),
  banned: boolean('banned').notNull().default(false),
  banReason: text('ban_reason'),
  banExpires: at('ban_expires'),
}, (table) => [check('user_admin_only_active_check', sql`${table.role} = 'admin' OR ${table.banned} = true`)]);

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: at('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  impersonatedBy: text('impersonated_by'),
}, (table) => [index('session_user_id_idx').on(table.userId)]);

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: at('access_token_expires_at'),
  refreshTokenExpiresAt: at('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
}, (table) => [index('account_user_id_idx').on(table.userId)]);

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: at('expires_at').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
}, (table) => [index('verification_identifier_idx').on(table.identifier)]);

export const demoTasks = pgTable('demo_tasks', {
  id: uuid('id').primaryKey(),
  label: text('label').notNull(),
  status: text('status').notNull().default('queued'),
  queueJobId: text('queue_job_id').notNull(),
  result: text('result'),
  error: text('error'),
  createdBy: text('created_by').notNull().references(() => user.id),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
  completedAt: at('completed_at'),
}, (table) => [index('demo_tasks_created_at_idx').on(table.createdAt)]);

export const operationAudit = pgTable('operation_audit', {
  id: uuid('id').primaryKey(),
  action: text('action').notNull(),
  targetId: uuid('target_id').notNull(),
  actorUserId: text('actor_user_id').notNull().references(() => user.id),
  requestHash: text('request_hash').notNull(),
  details: jsonb('details').$type<Record<string, string>>().notNull().default({}),
  createdAt: at('created_at').notNull().defaultNow(),
}, (table) => [index('operation_audit_target_idx').on(table.targetId)]);

export const fileIndex = pgTable('file_index', {
  id: uuid('id').primaryKey(),
  storageKey: text('storage_key').notNull().unique(),
  sha256: text('sha256').notNull(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
  originalName: text('original_name').notNull(),
  mimeType: text('mime_type').notNull(),
  createdBy: text('created_by').references(() => user.id),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const workerHeartbeat = pgTable('worker_heartbeat', {
  name: text('name').primaryKey(),
  lastSeenAt: at('last_seen_at').notNull(),
  processId: integer('process_id').notNull(),
});

export const sellerMappings = pgTable('seller_mapping', {
  id: uuid('id').primaryKey(),
  sid: integer('sid').notNull().unique(),
  name: text('name').notNull(),
  country: text('country').notNull(),
  marketplaceId: text('marketplace_id'),
  wid: text('wid'),
  status: text('status').notNull().default('candidate'),
  version: integer('version').notNull().default(1),
  sourceObservedAt: at('source_observed_at').notNull(),
  sourceSha256: text('source_sha256').notNull(),
  sourceFileId: uuid('source_file_id').references(() => fileIndex.id),
  updatedAt: at('updated_at').notNull().defaultNow(),
  manualEnabled: boolean('manual_enabled').notNull().default(true),
  lingxingAutoApproved: boolean('lingxing_auto_approved').notNull().default(false),
  lingxingDisabled: boolean('lingxing_disabled').notNull().default(false),
  lingxingData: jsonb('lingxing_data').$type<{ name: string; country: string; marketplaceId: string | null; status: string; present: boolean; observedAt: string; sha256?: string; fileId?: string }>(),
}, (table) => [
  check('seller_mapping_status_check', sql`${table.status} IN ('candidate', 'approved', 'disabled')`),
  check('seller_mapping_version_check', sql`${table.version} > 0`),
  check('seller_mapping_sid_check', sql`${table.sid} > 0`),
]);

export const sellerAliases = pgTable('seller_alias', {
  normalizedAlias: text('normalized_alias').primaryKey(),
  alias: text('alias').notNull(),
  sellerMappingId: uuid('seller_mapping_id').notNull().references(() => sellerMappings.id),
}, (table) => [index('seller_alias_mapping_idx').on(table.sellerMappingId)]);

export const sellerMappingRevisions = pgTable('seller_mapping_revision', {
  operationId: uuid('operation_id').primaryKey(),
  sellerMappingId: uuid('seller_mapping_id').notNull().references(() => sellerMappings.id),
  version: integer('version').notNull(),
  actorUserId: text('actor_user_id').notNull().references(() => user.id),
  requestHash: text('request_hash').notNull(),
  reason: text('reason').notNull(),
  before: jsonb('before').$type<Record<string, unknown>>().notNull(),
  after: jsonb('after').$type<Record<string, unknown>>().notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
}, (table) => [index('seller_mapping_revision_target_idx').on(table.sellerMappingId),
  uniqueIndex('seller_mapping_revision_version_idx').on(table.sellerMappingId, table.version)]);

export const sourceMappingVersions = pgTable('source_mapping_version', {
  key: text('key').primaryKey(), parserVersion: text('parser_version').notNull(),
  definition: jsonb('definition').$type<Record<string, string>>().notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const sourceImports = pgTable('source_import', {
  id: uuid('id').primaryKey(), fileId: uuid('file_id').notNull().references(() => fileIndex.id),
  sha256: text('sha256').notNull(), originalName: text('original_name').notNull(), byteSize: integer('byte_size').notNull(),
  sourceType: text('source_type').notNull().default('xlsx'),
  createdBy: text('created_by').notNull().references(() => user.id), importedAt: at('imported_at').notNull(),
  businessDate: date('business_date').notNull(), datePolicyVersion: text('date_policy_version').notNull(),
  weekStartDate: date('week_start_date').notNull(), weekEndDate: date('week_end_date').notNull(),
  status: text('status').notNull().default('queued'), version: integer('version').notNull().default(1),
  latestRunId: uuid('latest_run_id').references((): AnyPgColumn => importParseRuns.id),
  sheets: jsonb('sheets').$type<ImportSheet[]>().notNull().default([]),
}, (table) => [uniqueIndex('source_import_owner_sha_idx').on(table.createdBy, table.sha256),
  check('source_import_type_check', sql`${table.sourceType} IN ('xlsx','online')`),
  index('source_import_owner_time_idx').on(table.createdBy, table.importedAt),
  check('source_import_status_check', sql`${table.status} IN ('queued','parsing','awaiting_mapping','preview_ready','failed')`),
  check('source_import_version_check', sql`${table.version} > 0`),
  check('source_import_size_check', sql`${table.byteSize} > 0 AND ${table.byteSize} <= 10485760`)]);

export const importParseRuns = pgTable('import_parse_run', {
  id: uuid('id').primaryKey(), importId: uuid('import_id').notNull().references(() => sourceImports.id),
  queueJobId: text('queue_job_id').notNull(), createdBy: text('created_by').notNull().references(() => user.id),
  status: text('status').notNull().default('queued'), inputVersion: integer('input_version').notNull(),
  mappingVersion: text('mapping_version').references(() => sourceMappingVersions.key), sheetName: text('sheet_name'),
  parserVersion: text('parser_version').notNull(), processedRows: integer('processed_rows').notNull().default(0),
  counts: jsonb('counts').$type<ImportCounts>().notNull().default({ totalRows: 0, validFbaRows: 0, errorRows: 0, warningRows: 0 }),
  issues: jsonb('issues').$type<ImportIssue[]>().notNull().default([]), errorCode: text('error_code'), errorMessage: text('error_message'),
  createdAt: at('created_at').notNull().defaultNow(), startedAt: at('started_at'), completedAt: at('completed_at'),
}, (table) => [index('import_parse_run_import_idx').on(table.importId, table.createdAt),
  check('import_parse_run_status_check', sql`${table.status} IN ('queued','running','completed','failed')`),
  check('import_parse_run_version_check', sql`${table.inputVersion} > 0`)]);

export const sourceImportRows = pgTable('source_import_row', {
  id: uuid('id').primaryKey(), parseRunId: uuid('parse_run_id').notNull().references(() => importParseRuns.id),
  sheetName: text('sheet_name').notNull(), rowNumber: integer('row_number').notNull(), hidden: boolean('hidden').notNull().default(false),
  status: text('status').notNull(), rawCells: jsonb('raw_cells').$type<ImportRawCell[]>().notNull(),
  normalized: jsonb('normalized').$type<ImportNormalizedRow>().notNull(), issues: jsonb('issues').$type<ImportIssue[]>().notNull(),
}, (table) => [uniqueIndex('source_import_row_run_number_idx').on(table.parseRunId, table.rowNumber),
  index('source_import_row_run_status_idx').on(table.parseRunId, table.status),
  check('source_import_row_number_check', sql`${table.rowNumber} > 0`),
  check('source_import_row_status_check', sql`${table.status} IN ('valid','needs_review','error')`)]);

export const importOperations = pgTable('import_operation', {
  operationId: uuid('operation_id').primaryKey(), kind: text('kind').notNull(), actorUserId: text('actor_user_id').notNull().references(() => user.id),
  requestHash: text('request_hash').notNull(), importId: uuid('import_id').notNull().references(() => sourceImports.id),
  parseRunId: uuid('parse_run_id').notNull().references(() => importParseRuns.id), deduplicated: boolean('deduplicated').notNull().default(false),
  createdAt: at('created_at').notNull().defaultNow(),
}, (table) => [check('import_operation_kind_check', sql`${table.kind} IN ('upload','parse')`)]);

export const demands = pgTable('demand', {
  ...shippingLifecycleColumns(),
  id: uuid('id').primaryKey(), sid: integer('sid').notNull(), fba: text('fba').notNull(),
  snapshot: jsonb('snapshot').$type<DemandSnapshot>().notNull(), version: integer('version').notNull(),
  businessDate: date('business_date').notNull(), weekStartDate: date('week_start_date').notNull(), weekEndDate: date('week_end_date').notNull(),
  createdAt: at('created_at').notNull().defaultNow(), updatedAt: at('updated_at').notNull().defaultNow(),
}, (table) => [uniqueIndex('demand_sid_fba_idx').on(table.sid, table.fba),
  check('demand_lifecycle_check', sql`${table.lifecycle} IN ('active','cancelled','trashed')`),
  check('demand_identity_check', sql`${table.sid} > 0 AND ${table.fba} ~ '^FBA[A-Z0-9]+$'`),
  check('demand_version_check', sql`${table.version} > 0`)]);

export const demandRevisions = pgTable('demand_revision', {
  id: uuid('id').primaryKey(), demandId: uuid('demand_id').notNull().references(() => demands.id),
  version: integer('version').notNull(), snapshot: jsonb('snapshot').$type<DemandSnapshot>().notNull(),
  createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(),
}, (table) => [uniqueIndex('demand_revision_version_idx').on(table.demandId, table.version), check('demand_revision_version_check', sql`${table.version} > 0`)]);

export const demandSources = pgTable('demand_source', {
  id: uuid('id').primaryKey(), demandId: uuid('demand_id').notNull().references(() => demands.id), acceptedVersion: integer('accepted_version').notNull(),
  importId: uuid('import_id').notNull().references(() => sourceImports.id), parseRunId: uuid('parse_run_id').notNull().references(() => importParseRuns.id),
  sourceRowId: uuid('source_row_id').notNull().references(() => sourceImportRows.id), sheetName: text('sheet_name').notNull(), rowNumber: integer('row_number').notNull(),
  location: jsonb('location').$type<ImportSourceLocation>().notNull(), mapping: jsonb('mapping').$type<ImportSellerConfirmation>().notNull(),
  createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(),
}, (table) => [uniqueIndex('demand_source_origin_idx').on(table.importId, table.sheetName, table.rowNumber), index('demand_source_demand_idx').on(table.demandId),
  foreignKey({ columns: [table.demandId, table.acceptedVersion], foreignColumns: [demandRevisions.demandId, demandRevisions.version], name: 'demand_source_revision_fk' }),
  check('demand_source_row_check', sql`${table.rowNumber} > 0`)]);

export const importPreviews = pgTable('import_preview', {
  id: uuid('id').primaryKey(), importId: uuid('import_id').notNull().references(() => sourceImports.id),
  parseRunId: uuid('parse_run_id').notNull().references(() => importParseRuns.id), importVersion: integer('import_version').notNull(),
  createdBy: text('created_by').notNull().references(() => user.id), payload: jsonb('payload').$type<ImportPreviewPayload>().notNull(), createdAt: at('created_at').notNull().defaultNow(),
}, (table) => [index('import_preview_import_idx').on(table.importId, table.createdAt)]);

export const importCommits = pgTable('import_commit', {
  operationId: uuid('operation_id').primaryKey(), importId: uuid('import_id').notNull().references(() => sourceImports.id),
  previewId: uuid('preview_id').notNull().references(() => importPreviews.id), actorUserId: text('actor_user_id').notNull().references(() => user.id),
  requestHash: text('request_hash').notNull(), result: jsonb('result').$type<ImportCommitResult>().notNull(), createdAt: at('created_at').notNull().defaultNow(),
}, (table) => [index('import_commit_import_idx').on(table.importId, table.createdAt)]);

export const sellerCatalogSettings = pgTable('seller_catalog_settings', {
  id: text('id').primaryKey(), mode: text('mode').notNull().default('lingxing'), version: integer('version').notNull().default(1), catalogVersion: integer('catalog_version').notNull().default(0),
  sourceFileId: uuid('source_file_id').references(() => fileIndex.id), lastSyncedAt: at('last_synced_at'), lastError: jsonb('last_error').$type<{ code: string; message: string }>(),
  updatedBy: text('updated_by').references(() => user.id), updatedAt: at('updated_at').notNull().defaultNow(),
}, (table) => [check('seller_catalog_mode_check', sql`${table.mode} IN ('lingxing','manual')`), check('seller_catalog_version_check', sql`${table.version} > 0 AND ${table.catalogVersion} >= 0`)]);

export const sellerCatalogOperations = pgTable('seller_catalog_operation', {
  operationId: uuid('operation_id').primaryKey(), kind: text('kind').notNull(), actorUserId: text('actor_user_id').notNull().references(() => user.id),
  requestHash: text('request_hash').notNull(), result: jsonb('result').$type<Record<string, unknown>>().notNull(), createdAt: at('created_at').notNull().defaultNow(),
});
export * from '../modules/lingxing/sync-schema.js';
export * from '../modules/imports/fba-lookup-schema.js';
export * from '../modules/shipping-runs/schema.js';
export * from '../modules/shipping-lifecycle/schema.js';
