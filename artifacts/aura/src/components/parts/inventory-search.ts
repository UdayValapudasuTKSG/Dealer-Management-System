export type SearchablePart = {
  id: number;
  sku: string;
  name: string;
  barcode?: string | null;
  stock: number;
  status?: string;
};

export function indexInventory(parts: SearchablePart[]) {
  return parts.map(part => ({
    part,
    text: `${part.sku} ${part.name} ${part.barcode ?? ""}`.toLowerCase(),
  }));
}

export function searchInventory(index: ReturnType<typeof indexInventory>, search: string, limit = 50) {
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches: SearchablePart[] = [];
  for (const entry of index) {
    if (terms.every(term => entry.text.includes(term))) {
      matches.push(entry.part);
      if (matches.length > limit) break;
    }
  }
  return { parts: matches.slice(0, limit), hasMore: matches.length > limit };
}
