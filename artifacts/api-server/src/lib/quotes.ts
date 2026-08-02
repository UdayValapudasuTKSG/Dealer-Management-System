import { and, desc, eq, ne, sql } from "drizzle-orm";
import {
  db,
  leadsTable,
  vehiclesTable,
  quotesTable,
  dealersTable,
  timelineEventsTable,
  activityTable,
  agentsTable,
  type Lead,
  type Quote,
  type Vehicle,
} from "@workspace/db";
import { computeTaxes, ensureDealerTaxes } from "./taxes";
import { logger } from "./logger";
import { recordAgentRun } from "./agent-governance";

// ---------------------------------------------------------------------------
// Quote agent (A3) — auto-generates the GT-format "Code" (estimate) for every
// lead with a vehicle of interest, priced deterministically from inventory
// with the dealer's configured taxes applied. Plain code, never an LLM.
// Sequential per-dealer estimate numbers; regenerations create new versions
// and prior versions are always retained.
// ---------------------------------------------------------------------------

export const QUOTE_AGENT_ACTOR = "AURA System";
const AGENT_KEY = "quote_tax";

const longDate = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

export type QuoteTrigger = "lead_created" | "lead_updated" | "manual";

/** Next sequential estimate number for the dealer (stable across versions of one lead). */
async function nextQuoteNumber(dealerId: number): Promise<string> {
  const [row] = await db
    .select({
      max: sql<number>`coalesce(max((substring(${quotesTable.quoteNumber} from '[0-9]+$'))::int), 0)::int`,
    })
    .from(quotesTable)
    .where(eq(quotesTable.dealerId, dealerId));
  return `EST-${String((row?.max ?? 0) + 1).padStart(5, "0")}`;
}

export async function leadVehicle(lead: Lead): Promise<Vehicle | null> {
  if (!lead.interestedVehicleId) return null;
  const [v] = await db
    .select()
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.id, lead.interestedVehicleId),
        eq(vehiclesTable.dealerId, lead.dealerId),
      ),
    );
  return v ?? null;
}

/**
 * Generate (or regenerate) the Code for a lead. Deterministic: price from the
 * inventory unit, taxes from the dealer's configured rules as of today.
 * Returns null when the lead has no resolvable vehicle of interest.
 */
export async function generateQuoteForLead(
  lead: Lead,
  opts: { actor: string; isAgent: boolean; trigger: QuoteTrigger },
): Promise<Quote | null> {
  const vehicle = await leadVehicle(lead);
  if (!vehicle) return null;

  const taxes = await ensureDealerTaxes(lead.dealerId);
  const now = new Date();
  const computed = computeTaxes(vehicle.price, taxes, {
    asOf: now,
    powertrain: vehicle.powertrain,
  });

  const [latest] = await db
    .select()
    .from(quotesTable)
    .where(and(eq(quotesTable.dealerId, lead.dealerId), eq(quotesTable.leadId, lead.id)))
    .orderBy(desc(quotesTable.version))
    .limit(1);

  const quoteNumber = latest?.quoteNumber ?? (await nextQuoteNumber(lead.dealerId));
  const version = (latest?.version ?? 0) + 1;

  // Prior versions are retained — only their status flips to superseded.
  if (latest) {
    await db
      .update(quotesTable)
      .set({ status: "superseded" })
      .where(
        and(
          eq(quotesTable.dealerId, lead.dealerId),
          eq(quotesTable.leadId, lead.id),
          ne(quotesTable.status, "superseded"),
        ),
      );
  }

  const validUntil = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const [quote] = await db
    .insert(quotesTable)
    .values({
      dealerId: lead.dealerId,
      leadId: lead.id,
      vehicleId: vehicle.id,
      quoteNumber,
      version,
      status: "current",
      customerName: lead.name,
      customerAddress: lead.address,
      modelYear: vehicle.year,
      vehicleLine: `${vehicle.make} ${vehicle.model}`,
      trim: vehicle.trim || vehicle.variant || lead.variant || null,
      color: vehicle.exteriorColor || lead.color || null,
      manufacturer: vehicle.make,
      mfgDate: String(vehicle.year),
      quantity: 1,
      basePrice: vehicle.price,
      taxLines: computed.lines,
      totalTax: computed.totalTax,
      total: computed.totalWithTax,
      issuedOn: longDate(now),
      validUntil: longDate(validUntil),
      trigger: opts.trigger,
      createdBy: opts.actor,
      isAgent: opts.isAgent,
    })
    .returning();

  const taxSummary =
    computed.lines.length > 0
      ? computed.lines
          .map((l) => `${l.name} $${l.amount.toLocaleString("en-US")}`)
          .join(", ")
      : "no taxes applicable";
  const detail =
    `${quoteNumber} rev ${version} — ${vehicle.year} ${vehicle.make} ${vehicle.model}, ` +
    `base $${vehicle.price.toLocaleString("en-US")}, ${taxSummary}, ` +
    `total $${computed.totalWithTax.toLocaleString("en-US")}.`;

  if (opts.isAgent) {
    await recordAgentRun({
      dealerId: lead.dealerId,
      agentKey: "quote_tax",
      runType: "quote_generation",
      autonomy: "system",
      inputSource: "quotes",
      inputSummary: `Lead #${lead.id}, trigger=${opts.trigger}`,
      outputSummary: detail,
      refType: "quote",
      refId: quote?.id ?? null,
      mutation: true,
    });
  }

  await db.insert(timelineEventsTable).values({
    dealerId: lead.dealerId,
    customerId: lead.customerId,
    domain: "leads",
    kind: version === 1 ? "quote_generated" : "quote_regenerated",
    title:
      version === 1
        ? `Code ${quoteNumber} generated`
        : `Code ${quoteNumber} regenerated (rev ${version})`,
    detail,
    actor: opts.actor,
    isAgent: opts.isAgent,
    refType: "lead",
    refId: lead.id,
  });

  if (opts.isAgent) {
    await db.insert(activityTable).values({
      dealerId: lead.dealerId,
      agentKey: AGENT_KEY,
      actor: QUOTE_AGENT_ACTOR,
      isAi: false,
      action: version === 1 ? "Generated quotation Code" : "Regenerated quotation Code",
      entity: lead.name,
      detail,
    });
  }

  return quote!;
}

/**
 * Fire-and-forget auto-generation hook for lead creation (Agent A3) —
 * never fails the request.
 */
export function autoQuoteOnLeadCreated(lead: Lead): void {
  void generateQuoteForLead(lead, {
    actor: QUOTE_AGENT_ACTOR,
    isAgent: true,
    trigger: "lead_created",
  }).catch((err) => {
    logger.error({ err, leadId: lead.id }, "Quote agent auto-generation failed");
  });
}

/**
 * Regenerate after a lead edit when a Code-relevant field changed
 * (vehicle, color, variant, financing) and a quote already exists.
 */
export function autoQuoteOnLeadUpdated(before: Lead, after: Lead): void {
  const relevant =
    before.interestedVehicleId !== after.interestedVehicleId ||
    before.color !== after.color ||
    before.variant !== after.variant ||
    before.budgetFinancing !== after.budgetFinancing ||
    before.purchaseType !== after.purchaseType;
  if (!relevant) return;
  void (async () => {
    const [existing] = await db
      .select({ id: quotesTable.id })
      .from(quotesTable)
      .where(
        and(eq(quotesTable.dealerId, after.dealerId), eq(quotesTable.leadId, after.id)),
      )
      .limit(1);
    if (!existing) return;
    await generateQuoteForLead(after, {
      actor: QUOTE_AGENT_ACTOR,
      isAgent: true,
      trigger: "lead_updated",
    });
  })().catch((err) => {
    logger.error({ err, leadId: after.id }, "Quote agent regeneration failed");
  });
}

/** Full lead row by id — used by routes that already validated tenancy. */
export async function quoteById(
  dealerId: number,
  leadId: number,
  quoteId: number,
): Promise<Quote | null> {
  const [q] = await db
    .select()
    .from(quotesTable)
    .where(
      and(
        eq(quotesTable.id, quoteId),
        eq(quotesTable.leadId, leadId),
        eq(quotesTable.dealerId, dealerId),
      ),
    );
  return q ?? null;
}

/** Map a stored quote to the string payload the PDF builder + email queue expect. */
export async function quotePdfPayload(
  quote: Quote,
): Promise<Record<string, string>> {
  const money = (n: number) =>
    `GY$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const [dealer] = await db
    .select({
      name: dealersTable.name,
      city: dealersTable.city,
      country: dealersTable.country,
    })
    .from(dealersTable)
    .where(eq(dealersTable.id, quote.dealerId))
    .limit(1);
  const gyd = (n: number) =>
    `GYD ${Math.round(n).toLocaleString("en-US")}`;
  return {
    totalGyd: gyd(quote.total),
    dealerName: dealer?.name ?? "",
    dealerAddress: [dealer?.city, dealer?.country].filter(Boolean).join(", "),
    exchangeRateNote: "All figures in GYD",
    name: quote.customerName,
    address: quote.customerAddress ?? "",
    vehicle: `${quote.modelYear} ${quote.vehicleLine}`,
    model: quote.vehicleLine,
    modelYear: String(quote.modelYear),
    manufacturer: quote.manufacturer,
    mfgDate: quote.mfgDate ?? "",
    version: quote.trim ?? "Standard specification",
    color: quote.color ?? "",
    quantity: String(quote.quantity),
    unitPrice: money(quote.basePrice),
    subtotal: money(quote.basePrice),
    taxLines: JSON.stringify(
      quote.taxLines.map((l) => ({
        name: l.kind === "percent" ? `${l.name} (${l.rate}%)` : l.name,
        amount: money(l.amount),
      })),
    ),
    totalTax: money(quote.totalTax),
    total: money(quote.total),
    quoteRef: `${quote.quoteNumber}-R${quote.version}`,
    issuedOn: quote.issuedOn,
    validUntil: quote.validUntil,
  };
}
