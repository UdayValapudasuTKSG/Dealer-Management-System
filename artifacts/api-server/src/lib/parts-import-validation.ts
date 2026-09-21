export const importFields = ["sku", "name", "description", "category", "unitCost", "unitPrice", "costingMethod", "reorderMin", "reorderMax", "barcode", "location", "stock"] as const;
export type ImportField = typeof importFields[number];
export type ImportOptions = { mode: "upsert" | "reject"; mapping?: Partial<Record<ImportField, string>>; applyStock?: boolean };
export type ImportError = { row: number; field: string; message: string };
export type ImportRow = Partial<Record<ImportField, string | number>> & { sku: string; name: string; unitCost: number; unitPrice: number };
export type PricingPolicy = { category: string | null; markupFactor: number };
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (quoted) throw new Error("Unterminated CSV quoted field");
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function mapImportRows(matrix: string[][], options: ImportOptions): Record<string, string>[] {
  const headers = matrix[0]?.map(h => h.trim().replace(/^\uFEFF/, "")) ?? [];
  if (!headers.length) throw new Error("File has no header row");
  if (new Set(headers.map(normalize)).size !== headers.length) throw new Error("Duplicate or ambiguous column headers");
  const aliases: Record<string, string> = { partnumber: "sku", partno: "sku", cost: "unitCost", price: "unitPrice", reorderlevel: "reorderMin", quantity: "stock", qty: "stock", bin: "location" };
  const indexes = new Map<string, number>();
  headers.forEach((h, i) => {
    const field = importFields.find(f => normalize(f) === normalize(h)) ?? aliases[normalize(h)];
    if (field) indexes.set(field, i);
  });
  for (const [field, header] of Object.entries(options.mapping ?? {})) {
    if (!importFields.includes(field as ImportField)) throw new Error(`Unknown mapping field: ${field}`);
    const index = headers.indexOf(header!);
    if (index < 0) throw new Error(`Mapped header not found: ${header}`);
    indexes.set(field, index);
  }
  for (const field of ["sku", "name", "unitCost"]) if (!indexes.has(field)) throw new Error(`Missing required column: ${field}`);
  return matrix.slice(1).map(cells => Object.fromEntries([...indexes].map(([field, index]) => [field, (cells[index] ?? "").trim()])));
}

export function validateImportRows(
  source: Record<string, string>[], options: ImportOptions, policies: PricingPolicy[],
  existing: Map<string, { category: string; reorderMin?: number; reorderMax?: number | null }> = new Map(),
  progress: { offset: number; seen: Map<string, number> } = { offset: 0, seen: new Map() },
): { rows: ImportRow[]; errors: ImportError[] } {
  const errors: ImportError[] = [], rows: ImportRow[] = [];
  const seen = progress.seen;
  source.forEach((input, index) => {
    const row = index + progress.offset + 2;
    const error = (field: string, message: string) => errors.push({ row, field, message });
    const result: Record<string, string | number> = {};
    for (const field of importFields) if (input[field] !== undefined && input[field] !== "") result[field] = input[field];
    for (const field of ["sku", "name", "unitCost"]) if (!input[field]?.trim()) error(field, "Required value is missing");
    const sku = input.sku?.trim() ?? "";
    if (seen.has(sku)) error("sku", `Duplicate SKU in file (first seen on row ${seen.get(sku)})`);
    else seen.set(sku, row);
    const old = existing.get(sku);
    if (old && options.mode === "reject") error("sku", "SKU already exists; select upsert to update");
    for (const field of ["unitCost", "unitPrice", "reorderMin", "reorderMax", "stock"]) {
      if (result[field] === undefined) continue;
      const raw = String(result[field]);
      const value = Number(raw);
      if (!/^(?:\d+\.?\d*|\.\d+)$/.test(raw) || !Number.isFinite(value) || value < 0) error(field, "Must be a finite nonnegative number");
      else if (["stock", "reorderMin", "reorderMax"].includes(field) && (!Number.isSafeInteger(value) || value > 2147483647)) error(field, "Must be a nonnegative 32-bit integer");
      result[field] = value;
    }
    if (result.stock !== undefined && !options.applyStock) error("stock", "Stock adjustment requires explicit applyStock=true");
    const min = result.reorderMin ?? old?.reorderMin ?? 5;
    const max = result.reorderMax ?? old?.reorderMax;
    if (max != null && Number(max) < Number(min)) error("reorderMax", "Must be at least reorderMin");
    if (result.costingMethod && !["fifo", "average", "landed"].includes(String(result.costingMethod))) error("costingMethod", "Use fifo, average, or landed");
    if (result.unitPrice === undefined) {
      const category = String(result.category ?? old?.category ?? "general");
      const policy = policies.find(p => p.category === category) ?? policies.find(p => p.category === null);
      if (!policy) error("unitPrice", `No pricing policy for ${category}; provide a unit price or configure markup`);
      else {
        result.unitPrice = Math.round(Number(result.unitCost) * policy.markupFactor * 100) / 100;
        if (!Number.isFinite(result.unitPrice)) error("unitPrice", "Calculated price is not finite");
      }
    }
    rows.push(result as ImportRow);
  });
  return { rows, errors };
}