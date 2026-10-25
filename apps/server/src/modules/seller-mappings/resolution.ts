const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();

// Callers select the current catalog identity before matching. Every distinct
// approved identity remains visible so a name/alias collision is never guessed.
export function findApprovedSellers<T extends { id: string; name?: string; status: string; aliases: string[] }>(source: string, sellers: T[]): T[] {
  const name = normalize(source);
  if (!name) return [];
  const matches = new Map<string, T>();
  for (const seller of sellers) {
    if (seller.status !== 'approved' || matches.has(seller.id)) continue;
    if ((seller.name !== undefined && normalize(seller.name) === name) || seller.aliases.some((alias) => normalize(alias) === name)) {
      matches.set(seller.id, seller);
    }
  }
  return [...matches.values()];
}
