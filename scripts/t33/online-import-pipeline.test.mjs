import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { importDraftContentSchema } from '../../packages/contracts/dist/import-drafts.js';
import { currentLookupRecord, emptyOnlineRow, mergeLookupRecord, needsLookupReview, refreshLookupEvidence, splitLookupFbas, trimOnlineRows, onlineTicketPreview, parsePastedCells, createOnlineChannelMatcher, isOnlineChannelSelectable, onlineChannelOptions } from '../../apps/web/src/features/online-import-grid.ts';

const method = (name, enabled = true, id = name) => ({ id, name, enabled, remark: '' });

test('pasted pinyin initials resolve to the actual enabled dictionary values', () => {
  const names = ['海运', '海派', '空派', '快递', '铁运', '卡航'];
  const match = createOnlineChannelMatcher(names.map((name) => method(name)));
  const pasted = parsePastedCells(' HY \r\nhp\r\nKP\r\nkd\r\nTy\r\nkh\r\n');
  assert.deepEqual(pasted.map(([value]) => match(value).value), names);
  for (const name of names) assert.equal(match(` ${name} `).value, name);
  for (const value of ['', 'HYKD', '海运整柜', '__proto__']) assert.equal(match(value).value, value);
  assert.equal(match('  ').value, '');
});

test('new channel names, phrase pronunciation and mixed identifiers require no fixed alias table', () => {
  const match = createOnlineChannelMatcher(['欧洲铁路专线', '重庆专线', 'US 海派-2'].map((name) => method(name)));
  assert.equal(match(' oztlzx ').value, '欧洲铁路专线');
  assert.equal(match('CQZX').value, '重庆专线');
  assert.equal(match('ushp2').value, 'US 海派-2');
  assert.equal(match('OZ').value, 'OZ', 'partial initials never select a different value');
  assert.equal(match('HY').value, 'HY', 'missing names never become invented dictionary options');
});

test('ambiguous pinyin initials stay unchanged with distinct candidates for manual selection', () => {
  const match = createOnlineChannelMatcher([method('海派'), method('海配'), method('海派', true, 'duplicate')]);
  assert.deepEqual(match(' hp '), { value: 'hp', candidates: ['海派', '海配'] });
  assert.deepEqual(match('海派'), { value: '海派', candidates: [] }, 'an exact actual value wins');
  const actualCode = createOnlineChannelMatcher([method('HP'), method('海派'), method('海配')]);
  assert.equal(actualCode('HP').value, 'HP');
  assert.equal(actualCode('hp').value, 'HP', 'a literal dictionary value wins over pinyin initials');
});

test('disabled and unavailable dictionary entries do not resolve abbreviations', () => {
  const methods = [method('海派'), method('海配', false), method('卡航', false)];
  const match = createOnlineChannelMatcher(methods);
  assert.equal(match('HP').value, '海派', 'disabled names do not create ambiguity');
  assert.equal(match('KH').value, 'KH');
  assert.equal(match('海配').value, '海配', 'disabled exact values remain visible for correction');
  assert(isOnlineChannelSelectable(match('HP').value, methods));
  assert(!isOnlineChannelSelectable(match('KH').value, methods));
  assert(!isOnlineChannelSelectable(match('HY').value, methods));
  assert.equal(createOnlineChannelMatcher([])('HP').value, 'HP', 'keep input until the dictionary is available');
});

test('transport dropdown preserves unknown values and excludes disabled methods from new selections', () => {
  const methods = [{ id: '1', name: '海派', enabled: true, remark: '' }, { id: '2', name: '海卡', enabled: false, remark: '' }];
  assert(isOnlineChannelSelectable('', methods));
  assert(isOnlineChannelSelectable('海派', methods));
  assert(!isOnlineChannelSelectable('海运', methods));
  assert(!isOnlineChannelSelectable('海卡', methods));
  assert(!isOnlineChannelSelectable(' 海派 ', methods));
  const options = onlineChannelOptions(methods, '海运');
  assert.equal(options.find((option) => option.value === '海运').disabled, true);
  assert.equal(options.find((option) => option.value === '海卡').disabled, true);
  assert.equal(options.find((option) => option.value === '海派').disabled, false);
  assert.equal(onlineChannelOptions([...methods, { ...methods[0], id: '3' }], '').filter((option) => option.value === '海派').length, 1);
});

// The web matcher and grid helpers run locally without an application server or credentials.
const row = (fba, values = {}) => ({ id: randomUUID(), value: { ...emptyOnlineRow(), fba, ...values } });
const candidate = { sid: 101, shop: '测试店铺', country: '美国', destinationFc: 'ONT8', destinationAddress: 'Test address', shipmentCreatedAt: '2026-10-16', channel: '海派', channelStatus: 'unique', channelOptions: [{ name: '海派' }] };
const record = (fbas, overrides = {}) => ({ id: randomUUID(), status: 'completed', rows: fbas.map((fba) => ({ fba, status: 'unique', candidates: [{ ...candidate, ...overrides }] })) });

test('pasted blank boundaries survive draft serialization and exclude leading/trailing padding', () => {
  const rows = parsePastedCells('\r\nFBAONE\r\nFBATWO\r\n \r\n\r\nFBATHREE\r\n\r\n').map(([fba]) => row(fba));
  const kept = trimOnlineRows(rows);
  assert.equal(kept.length, 5);
  assert.deepEqual(onlineTicketPreview(kept).map(({ count }) => count), [2, 1]);
  const operationId = randomUUID();
  const online = { operationId, rows: kept.map((entry) => entry.value), startDate: '2026-10-01', endDate: '2026-10-23' };
  const draft = importDraftContentSchema.parse({ source: 'online', progress: { source: 'online', step: 2, importId: null }, online,
    shipping: { enabled: true, numberingDate: '2026-10-23', operationId: randomUUID() } });
  const restored = JSON.parse(JSON.stringify(draft)).online.rows.map((value) => ({ value }));
  assert.deepEqual(onlineTicketPreview(restored).map(({ count }) => count), [2, 1]);
  assert.equal(draft.shipping.numberingDate, '2026-10-23');
  assert.equal(splitLookupFbas(restored).flat().length, 3, 'lookup batching never consumes ticket boundaries');
});

test('a non-FBA business value is a member requiring correction, never a separator', () => {
  const rows = [row('FBAONE'), row('', { notes: 'Missing FBA must be fixed' }), row(''), row('FBATWO')];
  assert.deepEqual(onlineTicketPreview(rows).map(({ count }) => count), [2, 1]);
  assert.equal(trimOnlineRows([row(''), row('')]).length, 0);
});

test('saved automatic shipping keeps an uncertain creation request unchanged', () => {
  const importId = randomUUID(), operationId = randomUUID();
  const shipping = { enabled: true, numberingDate: '2026-10-23', operationId,
    pending: { operationId, importId, parseRunId: randomUUID(), numberingDate: '2026-10-23' } };
  const content = { source: 'file', progress: { source: 'file', importId, step: 2 }, shipping };
  assert(importDraftContentSchema.safeParse(content).success);
  for (const change of [{ operationId: randomUUID() }, { importId: randomUUID() }, { numberingDate: '2026-10-24' }]) {
    assert.equal(importDraftContentSchema.safeParse({ ...content, shipping: { ...shipping, pending: { ...shipping.pending, ...change } } }).success, false);
  }
});

test('1000 online rows query normalized duplicate FBAs once in sequential-sized batches', () => {
  const input = Array.from({ length: 999 }, (_, index) => row(`FBA${String(index).padStart(5, '0')}`));
  input.push(row(' fba00000 '));
  const batches = splitLookupFbas(input);
  assert.equal(batches.length, 10);
  assert(batches.every((batch) => batch.length <= 100));
  assert.equal(batches.flat().length, 999);
  assert.deepEqual(splitLookupFbas(input, new Set(batches.flat())), []);
});

test('fresh enrichment is immediately usable for every duplicate row and preserves provenance', () => {
  const result = record(['FBA123']);
  const enriched = mergeLookupRecord([row(' fba123 '), row('FBA123')], result);
  assert(enriched.every((entry) => entry.value.lookupId === result.id && entry.value.lookupSid === candidate.sid));
  assert(enriched.every((entry) => entry.value.shop === candidate.shop && !needsLookupReview(entry)));
  assert(enriched.every((entry) => entry.autofilled.channel === '海派'));
});

test('manual conflicts pause parsing while the unique transport method replaces abbreviations', () => {
  const enriched = mergeLookupRecord([row('FBA123', { shop: '人工店铺', country: '加拿大', channel: 'HYKD' })], record(['FBA123']))[0];
  assert.equal(enriched.value.shop, '人工店铺');
  assert.equal(enriched.value.country, '加拿大');
  assert.equal(enriched.value.channel, '海派');
  assert.equal(enriched.value.lookupId, undefined);
  assert(needsLookupReview(enriched));
  const corrected = refreshLookupEvidence({ ...enriched, value: { ...enriched.value, shop: candidate.shop, country: candidate.country } });
  assert.equal(corrected.value.lookupId, enriched.lookupId);
  assert.equal(needsLookupReview(corrected), false);
});

test('missing and ambiguous channels require confirmation or an actual selected transport option', () => {
  const missing = mergeLookupRecord([row('FBA123', { channel: '人工渠道' })], record(['FBA123'], { channel: null, channelStatus: 'unavailable', channelOptions: [] }))[0];
  assert.equal(missing.value.channel, '人工渠道');
  assert(needsLookupReview(missing));
  const ambiguous = mergeLookupRecord([row('FBA123')], record(['FBA123'], { channel: null, channelStatus: 'ambiguous', channelOptions: [{ name: '空派' }, { name: '海派' }] }))[0];
  assert(needsLookupReview(ambiguous));
  assert.equal(needsLookupReview({ ...ambiguous, value: { ...ambiguous.value, channel: '海派' } }), false);
  const notFound = { ...missing, lookup: { fba: 'FBA123', status: 'not_found', candidates: [] } };
  assert(needsLookupReview(notFound));
  const restoredRecord = record(['FBA123'], { channel: null, channelStatus: 'ambiguous', channelOptions: [{ name: '空派' }, { name: '海派' }] });
  const restored = mergeLookupRecord([{ ...row('FBA123', { lookupId: restoredRecord.id, lookupSid: 101, channel: '海派' }), autofilled: { channel: '海派' } }], restoredRecord)[0];
  assert.equal(restored.value.channel, '海派', 'a saved explicitly selected transport option survives result hydration');
  assert.equal(needsLookupReview(restored), false);
});

test('pending submission drafts accept only their original operation and exact rows', () => {
  const operationId = randomUUID(), rows = [row('FBA123').value];
  const online = { operationId, rows, startDate: '2026-10-01', endDate: '2026-10-23', pendingSubmission: { operationId, rows } };
  const content = { source: 'online', progress: { source: 'online', step: 2, importId: null }, online };
  assert(importDraftContentSchema.safeParse(content).success);
  assert.equal(importDraftContentSchema.safeParse({ ...content, online: { ...online, pendingSubmission: { operationId: randomUUID(), rows } } }).success, false);
  assert.equal(importDraftContentSchema.safeParse({ ...content, online: { ...online, pendingSubmission: { operationId, rows: [{ ...rows[0], notes: 'changed' }] } } }).success, false);
  assert(importDraftContentSchema.safeParse({ ...content, online: { ...online, pendingSubmission: undefined } }).success, 'legacy drafts remain compatible');
});

test('restored lookup evidence expires after any catalog or date scope change', () => {
  const scope = { mode: 'manual', version: 3, catalogVersion: 8, startDate: '2026-10-01', endDate: '2026-10-23' };
  const result = { ...record(['FBA123']), catalogMode: scope.mode, catalogSettingsVersion: scope.version, catalogVersion: scope.catalogVersion, startDate: scope.startDate, endDate: scope.endDate };
  assert(currentLookupRecord(result, scope));
  for (const change of [{ mode: 'lingxing' }, { version: 4 }, { catalogVersion: 9 }, { startDate: '2026-10-02' }, { endDate: '2026-10-22' }]) assert.equal(currentLookupRecord(result, { ...scope, ...change }), false);
});
