import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';

// Business acceptance inputs belong in an ignored local configuration. Unit and
// browser fixtures in this repository use invented identities only.
const sellerSelectionSchema = z.object({ sourceShop: z.string().min(1), sid: z.number().int().positive(), name: z.string().min(1), country: z.string().min(1) });
export const acceptanceFixtureSchema = z.object({
  sourceFile: z.string().min(1), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/i), originalName: z.string().min(1).optional(),
  counts: z.object({ totalRows: z.number().int().positive(), validFbaRows: z.number().int().min(2), errorRows: z.number().int().nonnegative(), sellerCandidates: z.number().int().nonnegative() }),
  sellerSelections: z.array(sellerSelectionSchema).default([]),
  preferredFbas: z.array(z.string().regex(/^FBA[A-Z0-9]+$/)).default([]),
  lookupSourceDirs: z.array(z.string().min(1)).default([]),
  expectedRuntime: z.record(z.string(), z.number().int().nonnegative()).optional(),
});
export type AcceptanceFixture = z.infer<typeof acceptanceFixtureSchema>;

export function acceptanceSellerMatches(sourceShop: string, seller: { sid: number; name: string; country: string }, selections: AcceptanceFixture['sellerSelections']) {
  const normalize = (name: string) => name.normalize('NFKC').trim().toLowerCase();
  const selected = selections.filter((entry) => normalize(entry.sourceShop) === normalize(sourceShop));
  if (selected.length > 1) throw new Error('Private acceptance configuration contains duplicate seller selections');
  const explicit = selected[0];
  return explicit ? seller.sid === explicit.sid && seller.name === explicit.name && seller.country === explicit.country : normalize(seller.name) === normalize(sourceShop);
}

export async function readAcceptanceFixture(required?: true): Promise<AcceptanceFixture>;
export async function readAcceptanceFixture(required: false): Promise<AcceptanceFixture | null>;
export async function readAcceptanceFixture(required = true): Promise<AcceptanceFixture | null> {
  const file = process.env.IMPORT_ACCEPTANCE_CONFIG;
  if (!file) {
    if (!required) return null;
    throw new Error('Set IMPORT_ACCEPTANCE_CONFIG to a private JSON fixture configuration; see scripts/shared/acceptance-fixture.example.json');
  }
  const configPath = resolve(file);
  const fixture = acceptanceFixtureSchema.parse(JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, '')));
  const sourceFile = process.env.IMPORT_SOURCE_FILE ? resolve(process.env.IMPORT_SOURCE_FILE) : resolve(dirname(configPath), fixture.sourceFile);
  return { ...fixture, sourceFile, originalName: fixture.originalName ?? basename(sourceFile), lookupSourceDirs: fixture.lookupSourceDirs.map((directory) => resolve(dirname(configPath), directory)) };
}
