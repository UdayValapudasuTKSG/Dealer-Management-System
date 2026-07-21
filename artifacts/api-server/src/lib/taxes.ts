import { asc, eq } from "drizzle-orm";
import { db, dealerTaxesTable, DEFAULT_DEALER_TAXES, type DealerTax } from "@workspace/db";

/**
 * Deterministic tax engine (no LLM). Given a taxable base (USD-scale) and a
 * dealer's configured rules, computes each applicable line and the total.
 * Consumed by the quotation flow and available for tests.
 */
export type TaxLine = {
  code: string;
  name: string;
  kind: "percent" | "fixed";
  rate: number;
  amount: number;
};

export function computeTaxes(
  base: number,
  taxes: Pick<
    DealerTax,
    | "code"
    | "name"
    | "kind"
    | "rate"
    | "thresholdAmount"
    | "excludeEv"
    | "effectiveFrom"
    | "active"
  >[],
  opts: { asOf?: Date; powertrain?: string | null } = {},
): { lines: TaxLine[]; totalTax: number; totalWithTax: number } {
  const asOfDay = (opts.asOf ?? new Date()).toISOString().slice(0, 10);
  const pt = (opts.powertrain ?? "").toLowerCase();
  const isEv = pt === "ev" || pt === "electric";
  const lines: TaxLine[] = [];
  for (const t of taxes) {
    if (!t.active) continue;
    // effectiveFrom is a YYYY-MM-DD string; lexical compare is correct.
    if (t.effectiveFrom > asOfDay) continue;
    if (t.thresholdAmount != null && base <= t.thresholdAmount) continue;
    // Configurable EV exclusion (e.g. VAT 0% and no duty on electric vehicles).
    if (t.excludeEv && isEv) continue;
    const kind = t.kind === "fixed" ? "fixed" : "percent";
    const raw = kind === "percent" ? (base * t.rate) / 100 : t.rate;
    const amount = Math.round(raw * 100) / 100;
    if (amount <= 0) continue;
    lines.push({ code: t.code, name: t.name, kind, rate: t.rate, amount });
  }
  const totalTax = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  return {
    lines,
    totalTax,
    totalWithTax: Math.round((base + totalTax) * 100) / 100,
  };
}

/**
 * Service-invoice tax: applies the dealer's configured VAT rule (code "vat")
 * to the labor+parts base. Same deterministic engine as sales quotes — no
 * literal rates anywhere. Returns 0 when the dealer has no active VAT rule.
 */
export function computeServiceTax(
  base: number,
  taxes: Parameters<typeof computeTaxes>[1],
): { tax: number; total: number } {
  const vatRules = taxes.filter((t) => t.code === "vat");
  // Service work is never an EV-exempt sale — don't pass a powertrain.
  const { totalTax } = computeTaxes(base, vatRules);
  return {
    tax: totalTax,
    total: Math.round((base + totalTax) * 100) / 100,
  };
}

/**
 * GRA vehicle-duty computation from the dealer's configured tax rules.
 * Deterministic, server-side — the AI never computes amounts. Duty/excise/
 * levies are assessed on the CIF value; VAT is assessed on (CIF + duty +
 * other levies), matching customs practice. Rules are matched by code:
 * import_duty, excise, vat; any other active rules land in `otherLevies`.
 */
export function computeGraDuty(
  cifValue: number,
  taxes: DealerTax[],
  opts: { isEv?: boolean } = {},
): {
  importDuty: number;
  exciseDuty: number;
  vat: number;
  otherLevies: TaxLine[];
  /** Every assessed line (duty, excise, levies, then VAT) in display order. */
  lines: TaxLine[];
  totalPayable: number;
} {
  const powertrain = opts.isEv ? "ev" : null;
  const nonVat = taxes.filter((t) => t.code !== "vat");
  const preVat = computeTaxes(cifValue, nonVat, { powertrain });
  const importDuty =
    preVat.lines.find((l) => l.code === "import_duty")?.amount ?? 0;
  const exciseDuty = preVat.lines.find((l) => l.code === "excise")?.amount ?? 0;
  const otherLevies = preVat.lines.filter(
    (l) => l.code !== "import_duty" && l.code !== "excise",
  );
  const vatBase = Math.round((cifValue + preVat.totalTax) * 100) / 100;
  const vatRules = taxes.filter((t) => t.code === "vat");
  const vatResult = computeTaxes(vatBase, vatRules, { powertrain });
  const vat = vatResult.totalTax;
  const lines = [...preVat.lines, ...vatResult.lines];
  const totalPayable =
    Math.round((preVat.totalTax + vat) * 100) / 100;
  return { importDuty, exciseDuty, vat, otherLevies, lines, totalPayable };
}

/** Fetch the dealer's tax rules, seeding the Guyana defaults on first read. */
export async function ensureDealerTaxes(dealerId: number): Promise<DealerTax[]> {
  const rows = await db
    .select()
    .from(dealerTaxesTable)
    .where(eq(dealerTaxesTable.dealerId, dealerId))
    .orderBy(asc(dealerTaxesTable.sortOrder), asc(dealerTaxesTable.id));
  if (rows.length > 0) return rows;
  const today = new Date().toISOString().slice(0, 10);
  await db.insert(dealerTaxesTable).values(
    DEFAULT_DEALER_TAXES.map((t, i) => ({
      dealerId,
      name: t.name,
      code: t.code,
      kind: t.kind,
      rate: t.rate,
      thresholdAmount: t.thresholdAmount,
      excludeEv: t.excludeEv,
      effectiveFrom: today,
      active: true,
      sortOrder: i,
      createdBy: "system",
    })),
  );
  return db
    .select()
    .from(dealerTaxesTable)
    .where(eq(dealerTaxesTable.dealerId, dealerId))
    .orderBy(asc(dealerTaxesTable.sortOrder), asc(dealerTaxesTable.id));
}
