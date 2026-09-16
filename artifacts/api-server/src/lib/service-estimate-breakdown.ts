import { and, eq } from "drizzle-orm";
import {
  db,
  externalJobCardPartsTable,
  jobCardPartsTable,
  jobCardsTable,
  type JobCard,
  type ServiceEstimateLine,
} from "@workspace/db";
import { computeServiceTax, ensureDealerTaxes } from "./taxes";

/**
 * The one customer-price calculation for a service job.
 *
 * A service estimate and its eventual invoice must be based on this exact
 * breakdown: net issued internal parts (returns reduce the price), externally
 * sourced parts, labour, a decided surcharge, and the configured service VAT.
 * Keeping tax as an itemized line makes `sum(lines) === total` true, rather
 * than asking a customer to infer an extra charge from the headline amount.
 */
export type ServiceEstimateBreakdown = {
  lines: ServiceEstimateLine[];
  internalPartsTotal: number;
  externalPartsTotal: number;
  labourTotal: number;
  surchargeTotal: number;
  tax: number;
  subtotal: number;
  total: number;
};

const cents = (amount: number) => Math.round((Number(amount) || 0) * 100) / 100;

export function canonicalizeServiceEstimateLines(
  lines: ServiceEstimateLine[],
): Array<{ kind: string; description: string; quantity: number | null; amount: number }> {
  return lines
    .map((line) => ({
      kind: line.kind,
      description: line.description.trim(),
      quantity: line.quantity == null ? null : Number(line.quantity),
      amount: cents(line.amount),
    }))
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        a.description.localeCompare(b.description) ||
        (a.quantity ?? 0) - (b.quantity ?? 0) ||
        a.amount - b.amount,
    );
}

/** True only when an immutable decision snapshot is exactly the live price. */
export function serviceEstimateLinesMatch(
  current: ServiceEstimateLine[],
  snapshot: ServiceEstimateLine[],
): boolean {
  return (
    JSON.stringify(canonicalizeServiceEstimateLines(current)) ===
    JSON.stringify(canonicalizeServiceEstimateLines(snapshot))
  );
}

/**
 * Build a current, itemized estimate inside the caller's transaction. `tx` is
 * intentionally structurally typed because Drizzle's transaction and database
 * query builders expose the same methods we need, while callers may have
 * already locked the job card.
 */
export async function buildServiceEstimateBreakdown(
  tx: any,
  card: Pick<
    JobCard,
    | "id"
    | "dealerId"
    | "laborHours"
    | "laborRate"
    | "surchargeStatus"
    | "surchargeAmount"
  >,
): Promise<ServiceEstimateBreakdown> {
  const [internal, external, taxes] = await Promise.all([
    tx
      .select({
        partName: jobCardPartsTable.partName,
        quantity: jobCardPartsTable.quantity,
        unitPrice: jobCardPartsTable.unitPrice,
        kind: jobCardPartsTable.kind,
      })
      .from(jobCardPartsTable)
      .where(
        and(
          eq(jobCardPartsTable.dealerId, card.dealerId),
          eq(jobCardPartsTable.jobCardId, card.id),
        ),
      ),
    tx
      .select({
        description: externalJobCardPartsTable.description,
        quantity: externalJobCardPartsTable.quantity,
        unitPrice: externalJobCardPartsTable.unitPrice,
      })
      .from(externalJobCardPartsTable)
      .where(
        and(
          eq(externalJobCardPartsTable.dealerId, card.dealerId),
          eq(externalJobCardPartsTable.jobCardId, card.id),
        ),
      ),
    ensureDealerTaxes(card.dealerId),
  ]);

  // Return rows are deliberately netted against the issued item at its locked
  // job-card price. This prevents a part credit from remaining billable in a
  // revised estimate while retaining a readable single part line.
  const netInternal = new Map<string, { description: string; unitPrice: number; quantity: number }>();
  for (const line of internal) {
    const description = line.partName.trim() || "Part";
    const unitPrice = cents(line.unitPrice);
    const key = `${description}\u0000${unitPrice}`;
    const current = netInternal.get(key) ?? { description, unitPrice, quantity: 0 };
    current.quantity += line.kind === "return" ? -line.quantity : line.quantity;
    netInternal.set(key, current);
  }

  const lines: ServiceEstimateLine[] = [];
  let internalPartsTotal = 0;
  for (const line of [...netInternal.values()].sort((a, b) =>
    a.description.localeCompare(b.description) || a.unitPrice - b.unitPrice,
  )) {
    if (!line.quantity) continue;
    const amount = cents(line.quantity * line.unitPrice);
    internalPartsTotal = cents(internalPartsTotal + amount);
    lines.push({
      kind: "part",
      description: line.description,
      quantity: line.quantity,
      amount,
    });
  }

  let externalPartsTotal = 0;
  for (const line of external) {
    const amount = cents(line.quantity * line.unitPrice);
    externalPartsTotal = cents(externalPartsTotal + amount);
    lines.push({
      kind: "part",
      description: line.description.trim() || "Externally sourced part",
      quantity: line.quantity,
      amount,
    });
  }

  const labourTotal = cents(card.laborHours * card.laborRate);
  if (labourTotal) {
    lines.push({
      kind: "labour",
      description: "Labour",
      quantity: card.laborHours,
      amount: labourTotal,
    });
  }
  const surchargeTotal =
    card.surchargeStatus === "applied" ? cents(card.surchargeAmount) : 0;
  if (surchargeTotal) {
    lines.push({
      kind: "surcharge",
      description: "Service surcharge",
      quantity: 1,
      amount: surchargeTotal,
    });
  }

  const subtotal = cents(
    internalPartsTotal + externalPartsTotal + labourTotal + surchargeTotal,
  );
  const { tax, total } = computeServiceTax(subtotal, taxes);
  if (tax) {
    lines.push({ kind: "tax", description: "Tax", quantity: 1, amount: tax });
  }
  const itemizedTotal = cents(lines.reduce((sum, line) => sum + line.amount, 0));
  if (itemizedTotal !== total) {
    throw new Error("service_estimate_breakdown_total_mismatch");
  }
  return {
    lines,
    internalPartsTotal,
    externalPartsTotal,
    labourTotal,
    surchargeTotal,
    tax,
    subtotal,
    total,
  };
}

/** Load a card only when a caller needs a standalone current breakdown. */
export async function loadServiceEstimateBreakdown(
  cardId: number,
  dealerId: number,
): Promise<{ card: JobCard; breakdown: ServiceEstimateBreakdown } | null> {
  const [card] = await db
    .select()
    .from(jobCardsTable)
    .where(and(eq(jobCardsTable.id, cardId), eq(jobCardsTable.dealerId, dealerId)));
  if (!card) return null;
  return { card, breakdown: await buildServiceEstimateBreakdown(db, card) };
}