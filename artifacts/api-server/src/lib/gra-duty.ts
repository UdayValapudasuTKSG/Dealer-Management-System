import { eq } from "drizzle-orm";
import {
  db,
  dealersTable,
  type DealerTax,
  type GraFilingTaxLine,
} from "@workspace/db";
import { ensureDealerTaxes } from "./taxes";

/**
 * GRA duty computation — deterministic, server-only, sourced STRICTLY from the
 * dealer's configured `dealer_taxes` rules (17-mB step 6 / R8.0). No AI ever
 * touches this math; the vision agent only transcribes legible fields.
 *
 * Rule application (documented boundary rules):
 *  - Category is derived from the rule code: *vat* → VAT, *duty* → import duty,
 *    *excise* → excise, everything else → levy/fee.
 *  - Import duty (percent): applies on the CIF value, only when CIF exceeds
 *    `thresholdAmount` (if set; a CIF exactly at the threshold is NOT dutiable).
 *  - Excise (percent): applies on CIF + import duty.
 *  - VAT (percent): applies on CIF + duty + excise (0% rules render as a 0 line).
 *  - Levies/fees: percent rules apply on CIF; fixed rules are flat USD-scale.
 *  - EV exclusion: when the powertrain is electric, every rule flagged
 *    `excludeEv` is skipped and reported in `evSkipped`.
 * All amounts USD-scale; GYD is display-only via the snapshotted exchange rate.
 */

export type GraDraftInputs = {
  cifValue: number;
  engineCc?: number | null;
  fuelType?: string | null;
  year?: number | null; // year of manufacture
  yearOfImport?: number | null;
};

export type GraDutyComputation = {
  taxLines: GraFilingTaxLine[];
  totalPayable: number;
  reviewFlags: string[];
  missingInputs: string[];
  isEv: boolean;
  /** Names of dealer_taxes rules skipped because of the EV exclusion. */
  evSkipped: string[];
};

export function isElectricFuel(fuelType: string | null | undefined): boolean {
  const f = (fuelType ?? "").trim().toLowerCase();
  return f === "electric" || f === "ev" || f === "bev";
}

type TaxCategory = "vat" | "duty" | "excise" | "levy";

export function taxCategory(rule: Pick<DealerTax, "code" | "name">): TaxCategory {
  const key = `${rule.code} ${rule.name}`.toLowerCase();
  if (key.includes("vat")) return "vat";
  if (key.includes("duty")) return "duty";
  if (key.includes("excise")) return "excise";
  return "levy";
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Compute the duty sheet for a (possibly incomplete) filing draft. Incomplete
 * inputs never throw: `missingInputs` lists exactly what the officer still has
 * to key in from the source documents, and the lines stay empty — the engine
 * never guesses a taxable base.
 */
export async function computeDraftDuty(
  dealerId: number,
  draft: GraDraftInputs,
): Promise<GraDutyComputation> {
  const isEv = isElectricFuel(draft.fuelType);

  const missing: string[] = [];
  if (!(draft.cifValue > 0)) missing.push("cifValue");
  if (!isEv && !(draft.engineCc && draft.engineCc > 0)) missing.push("engineCc");
  if (!draft.fuelType?.trim()) missing.push("fuelType");
  if (!(draft.year && draft.year > 1950)) missing.push("year");
  if (missing.length > 0) {
    return {
      taxLines: [],
      totalPayable: 0,
      reviewFlags: [],
      missingInputs: missing,
      isEv,
      evSkipped: [],
    };
  }

  const rules = (await ensureDealerTaxes(dealerId)).filter((r) => r.active);

  const cif = draft.cifValue;
  const lines: GraFilingTaxLine[] = [];
  const evSkipped: string[] = [];
  let dutyTotal = 0;
  let exciseTotal = 0;

  const pass = (want: TaxCategory) => {
    for (const rule of rules) {
      if (taxCategory(rule) !== want) continue;
      if (rule.excludeEv && isEv) {
        evSkipped.push(rule.name);
        continue;
      }
      if (rule.kind === "fixed") {
        lines.push({
          code: rule.code,
          name: rule.name,
          kind: "fixed",
          rate: rule.rate,
          basis: "Flat fee",
          baseAmount: null,
          amount: round2(rule.rate),
        });
        continue;
      }
      let base: number;
      let basis: string;
      if (want === "excise") {
        base = cif + dutyTotal;
        basis = "CIF + duty";
      } else if (want === "vat") {
        base = cif + dutyTotal + exciseTotal;
        basis = "CIF + duty + excise";
      } else {
        base = cif;
        basis = "CIF value";
      }
      if (want === "duty" && rule.thresholdAmount != null && cif <= rule.thresholdAmount) {
        lines.push({
          code: rule.code,
          name: rule.name,
          kind: "percent",
          rate: rule.rate,
          basis: `CIF at/below US$${rule.thresholdAmount.toLocaleString()} threshold`,
          baseAmount: cif,
          amount: 0,
        });
        continue;
      }
      const amount = round2((base * rule.rate) / 100);
      lines.push({
        code: rule.code,
        name: rule.name,
        kind: "percent",
        rate: rule.rate,
        basis,
        baseAmount: round2(base),
        amount,
      });
      if (want === "duty") dutyTotal += amount;
      if (want === "excise") exciseTotal += amount;
    }
  };

  // Deterministic order regardless of row order: duty → excise → VAT → levies.
  pass("duty");
  pass("excise");
  pass("vat");
  pass("levy");

  return {
    taxLines: lines,
    totalPayable: round2(lines.reduce((s, l) => s + l.amount, 0)),
    reviewFlags: [],
    missingInputs: [],
    isEv,
    evSkipped,
  };
}

/** Dealer's locked GYD-per-USD rate (defaults to 209 like the rest of the app). */
/**
 * Line-level equality between a stored/approved tax-line set and a fresh
 * recompute. Total-only checks are NOT enough: a tax-rule change can alter
 * the composition (codes, rates, bases) while preserving the total, which
 * would silently break the audit trail on the filed duty pack.
 */
export function taxLinesMatch(
  a: GraFilingTaxLine[],
  b: GraFilingTaxLine[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((l, i) => {
    const s = b[i];
    if (!s) return false;
    return (
      s.code === l.code &&
      s.kind === l.kind &&
      Math.abs((s.rate ?? 0) - (l.rate ?? 0)) < 1e-9 &&
      (s.basis ?? null) === (l.basis ?? null) &&
      Math.abs((s.baseAmount ?? 0) - (l.baseAmount ?? 0)) <= 0.01 &&
      Math.abs(s.amount - l.amount) <= 0.01
    );
  });
}

export async function dealerExchangeRate(dealerId: number): Promise<number> {
  const [dealer] = await db
    .select({ usdExchangeRate: dealersTable.usdExchangeRate })
    .from(dealersTable)
    .where(eq(dealersTable.id, dealerId));
  return dealer?.usdExchangeRate ?? 209;
}
