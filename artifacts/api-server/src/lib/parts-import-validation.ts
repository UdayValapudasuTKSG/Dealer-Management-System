import type { PartPricingDetails } from "@workspace/db";
export const pricingFields = ["unitCostUsd", "totalUsd", "cifUsd", "dutyRate", "vatRate", "dutyGyd", "vatGyd", "landedCostGyd", "sellingVatGyd", "finalSellingPriceGyd", "pricingQuantity"] as const;
export const importFields = ["sku", "name", "description", "category", "make", "supplier", "supplierId", "active", "unitCost", "unitPrice", "costingMethod", "reorderMin", "reorderMax", "barcode", "location", "stock", ...pricingFields] as const;
export type ImportField = typeof importFields[number];
export type ImportOptions = { mode: "upsert" | "reject"; mapping?: Partial<Record<ImportField, string>>; applyStock?: boolean };
export type ImportError = { row: number; field: string; message: string };
export type ImportRow = Partial<Record<ImportField, string | number | boolean>> & { sku: string; name: string; unitCost: number; unitPrice: number; pricingDetails?: PartPricingDetails };
export type ImportSupplier = { id: number; name: string; status?: string };
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
  const aliases: Record<string, string> = { partnumber: "sku", partno: "sku", partname: "name", cost: "unitCost", price: "unitPrice", reorderlevel: "reorderMin", quantity: "stock", qty: "stock", bin: "location", unitcostgyd: "unitCost", unitsp10gyd: "unitPrice", duty: "dutyRate", vat: "vatRate", lancostgyd: "landedCostGyd", "14vat": "sellingVatGyd", finalsp: "finalSellingPriceGyd" };
  const indexes = new Map<string, number>();
  Object.assign(aliases, { suppliername: "supplier", vendor: "supplier", sellprice: "unitPrice", sellingprice: "unitPrice", binlocation: "location", onhand: "stock" });
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
  suppliers: ImportSupplier[] = [],
): { rows: ImportRow[]; errors: ImportError[] } {
  const errors: ImportError[] = [], rows: ImportRow[] = [];
  const seen = progress.seen;
  source.forEach((input, index) => {
    const row = index + progress.offset + 2;
    const error = (field: string, message: string) => errors.push({ row, field, message });
    const result: Record<string, string | number | boolean> = {};
    for (const field of importFields) if (input[field] !== undefined && input[field] !== "") result[field] = input[field];
    for (const field of ["sku", "name", "unitCost"]) if (!input[field]?.trim()) error(field, "Required value is missing");
    const sku = input.sku?.trim() ?? "";
    if (seen.has(sku)) error("sku", `Duplicate SKU in file (first seen on row ${seen.get(sku)})`);
    else seen.set(sku, row);
    const old = existing.get(sku);
    if (result.active !== undefined) {
      const active = String(result.active).trim().toLowerCase();
      if (!["true", "false", "1", "0", "yes", "no"].includes(active)) error("active", "Use true/false, yes/no or 1/0");
      else result.active = ["true", "1", "yes"].includes(active);
    }
    if (result.supplierId !== undefined) {
      const id = Number(result.supplierId);
      if (!/^\d+$/.test(String(result.supplierId)) || !Number.isSafeInteger(id) || id <= 0) error("supplierId", "Use a positive integer supplier ID");
      else if (!suppliers.some(supplier => supplier.id === id)) error("supplierId", "Supplier ID not found in this dealership; choose an existing supplier");
      result.supplierId = id;
    }
    if (result.supplier !== undefined) {
      const name = String(result.supplier).trim().toLowerCase();
      const matches = suppliers.filter(supplier => supplier.name.trim().toLowerCase() === name);
      if (!matches.length) error("supplier", "Supplier name not found in this dealership; create it in Suppliers first or use an existing name");
      else if (matches.length > 1) error("supplier", "Supplier name is ambiguous; leave name blank and map Supplier ID instead");
      else if (result.supplierId !== undefined && result.supplierId !== matches[0].id) error("supplierId", "Supplier ID and name must identify the same supplier");
      else result.supplierId = matches[0].id;
    }
    delete result.supplier;
    const resolvedSupplier = suppliers.find(supplier => supplier.id === result.supplierId);
    if (resolvedSupplier?.status !== undefined && resolvedSupplier.status !== "active") error("supplierId", "Supplier is inactive; choose an active supplier or reactivate it in Suppliers first");
    if (old && options.mode === "reject") error("sku", "SKU already exists; select upsert to update");
    for (const field of ["unitCost", "unitPrice", "reorderMin", "reorderMax", "stock", ...pricingFields]) {
      if (result[field] === undefined) continue;
      const raw = String(result[field]);
      const value = Number(raw);
      if (!/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) || !Number.isFinite(value) || value < 0) error(field, "Must be a finite nonnegative number");
      else if (["stock", "pricingQuantity", "reorderMin", "reorderMax"].includes(field) && (!Number.isSafeInteger(value) || value > 2147483647)) error(field, "Must be a nonnegative 32-bit integer");
      else if (["dutyRate", "vatRate"].includes(field) && value > 1) error(field, "Use a fraction between 0 and 1");
      result[field] = value;
    }
    const hasPricing = pricingFields.some(field => result[field] !== undefined);
    if (result.stock !== undefined && !options.applyStock && !hasPricing) error("stock", "Stock adjustment requires explicit applyStock=true");
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
    let pricingDetails: PartPricingDetails | undefined;
    if (hasPricing) {
      pricingDetails = {};
      for (const field of pricingFields) {
        if (result[field] !== undefined) {
          pricingDetails[field === "pricingQuantity" ? "quantity" : field] = Number(result[field]);
        }
      }
      if (pricingDetails.quantity === undefined && result.stock !== undefined) pricingDetails.quantity = Number(result.stock);
      const d = pricingDetails;
      // Absolute two-cent tolerance plus floating point noise; do not assume
      // any markup, exchange rate, freight factor or selling tax rate.
      const check = (field: string, actual: number | undefined, expected: number | undefined, tolerance = 0.02) => {
        if (actual !== undefined && expected !== undefined && (!Number.isFinite(expected) || Math.abs(actual - expected) > tolerance + Math.abs(expected) * 1e-10)) error(field, "Inconsistent pricing arithmetic");
      };
      if (d.quantity !== undefined && d.unitCostUsd !== undefined) check("totalUsd", d.totalUsd, d.quantity * d.unitCostUsd);
      if (d.quantity !== undefined) check("landedCostGyd", d.landedCostGyd, d.quantity * Number(result.unitCost), Math.max(0.02, d.quantity * 0.005));
      if (d.landedCostGyd !== undefined && d.dutyGyd !== undefined && d.vatGyd !== undefined) {
        const baseGyd = d.landedCostGyd - d.dutyGyd - d.vatGyd;
        if (baseGyd < -0.02) error("landedCostGyd", "Landed cost cannot be less than duty plus VAT");
        if (d.dutyRate !== undefined) check("dutyGyd", d.dutyGyd, baseGyd * d.dutyRate);
        if (d.vatRate !== undefined) check("vatGyd", d.vatGyd, (baseGyd + d.dutyGyd) * d.vatRate);
      }
      if (d.sellingVatGyd !== undefined) check("finalSellingPriceGyd", d.finalSellingPriceGyd, Number(result.unitPrice) + d.sellingVatGyd);
      if (d.finalSellingPriceGyd !== undefined && d.finalSellingPriceGyd + 0.02 < Number(result.unitPrice)) error("finalSellingPriceGyd", "Final price cannot be less than pre-VAT selling price");
      for (const field of pricingFields) delete result[field];
      if (!options.applyStock) delete result.stock;
    }
    // Round only the canonical GYD master prices, retaining full worksheet precision.
    result.unitCost = Math.round(Number(result.unitCost) * 100) / 100;
    result.unitPrice = Math.round(Number(result.unitPrice) * 100) / 100;
    rows.push({ ...result, ...(pricingDetails ? { pricingDetails } : {}) } as ImportRow);
  });
  return { rows, errors };
}