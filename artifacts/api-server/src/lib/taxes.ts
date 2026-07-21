import type { DealerTax } from "@workspace/db";

/**
 * Deterministic tax engine (no LLM). Given a taxable base (USD-scale) and a
 * dealer's configured rules, computes each applicable line and the total.
 * Consumed by the quotation flow (downstream task) and available for tests.
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
    "code" | "name" | "kind" | "rate" | "thresholdAmount" | "effectiveFrom" | "active"
  >[],
  asOf: Date = new Date(),
): { lines: TaxLine[]; totalTax: number; totalWithTax: number } {
  const asOfDay = asOf.toISOString().slice(0, 10);
  const lines: TaxLine[] = [];
  for (const t of taxes) {
    if (!t.active) continue;
    // effectiveFrom is a YYYY-MM-DD string; lexical compare is correct.
    if (t.effectiveFrom > asOfDay) continue;
    if (t.thresholdAmount != null && base <= t.thresholdAmount) continue;
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
