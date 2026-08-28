import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  db,
  leadsTable,
  vehiclesTable,
  quotesTable,
  quoteItemsTable,
  quoteNumbersTable,
  leadVehicleInterestsTable,
  dealerTaxesTable,
  DEFAULT_DEALER_TAXES,
  dealersTable,
  timelineEventsTable,
  activityTable,
  agentsTable,
  type Lead,
  type Quote,
  type QuoteTaxLine,
  type Vehicle,
} from "@workspace/db";
import { logger } from "./logger";
import { recordAgentRun } from "./agent-governance";
import { computeTaxes, dutyFreeTaxRules } from "./taxes";

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

/** Normalized interests are canonical; the old lead columns are a projection. */
async function leadVehicles(lead: Lead): Promise<Array<{ vehicle: Vehicle; quantity: number; position: number }>> {
  const interests = await db
    .select({
      vehicleId: leadVehicleInterestsTable.vehicleId,
      quantity: leadVehicleInterestsTable.quantity,
      position: leadVehicleInterestsTable.position,
    })
    .from(leadVehicleInterestsTable)
    .where(and(
      eq(leadVehicleInterestsTable.dealerId, lead.dealerId),
      eq(leadVehicleInterestsTable.leadId, lead.id),
    ))
    .orderBy(leadVehicleInterestsTable.position);
  const ids = interests.map((interest) => interest.vehicleId);
  const vehicles = ids.length
    ? await db.select().from(vehiclesTable).where(and(
        eq(vehiclesTable.dealerId, lead.dealerId),
        inArray(vehiclesTable.id, ids),
      ))
    : [];
  const byId = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const resolved = interests.flatMap((interest) => {
    const vehicle = byId.get(interest.vehicleId);
    return vehicle ? [{ vehicle, quantity: interest.quantity, position: interest.position }] : [];
  });
  if (resolved.length) return resolved;
  const legacy = await leadVehicle(lead);
  return legacy ? [{ vehicle: legacy, quantity: 1, position: 0 }] : [];
}

/**
 * Generate (or regenerate) the Code for a lead. Deterministic: price from the
 * inventory unit, taxes from the dealer's configured rules as of today.
 * Returns null when the lead has no resolvable vehicle of interest.
 */
export async function generateQuoteForLead(
  lead: Lead,
  opts: {
    actor: string;
    isAgent: boolean;
    trigger: QuoteTrigger;
    requestType?: "standard" | "duty_free";
    /** Staff-entered overrides from the Generate Code dialog. */
    overrides?: { modelName?: string; modelYear?: number };
  },
): Promise<Quote | null> {
  const now = new Date();
  const requestType = opts.requestType ?? "standard";
  const validUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const committed = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`quote:${lead.dealerId}:${lead.id}`}))`,
    );
    const [currentLead] = await tx.select().from(leadsTable).where(and(
      eq(leadsTable.id, lead.id), eq(leadsTable.dealerId, lead.dealerId),
    )).for("update");
    if (!currentLead) return null;

    const interestRows = await tx.select().from(leadVehicleInterestsTable).where(and(
      eq(leadVehicleInterestsTable.dealerId, currentLead.dealerId),
      eq(leadVehicleInterestsTable.leadId, currentLead.id),
    )).orderBy(leadVehicleInterestsTable.position);
    const canonicalInterests = interestRows.length ? interestRows : currentLead.interestedVehicleId
      ? [{ vehicleId: currentLead.interestedVehicleId, quantity: 1, position: 0 }]
      : [];
    if (!canonicalInterests.length) return null;
    const vehicles = await tx.select().from(vehiclesTable).where(and(
      eq(vehiclesTable.dealerId, currentLead.dealerId),
      inArray(vehiclesTable.id, canonicalInterests.map((item) => item.vehicleId)),
    )).for("update");
    const vehicleById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
    const interests = canonicalInterests.flatMap((interest) => {
      const vehicle = vehicleById.get(interest.vehicleId);
      return vehicle ? [{ vehicle, quantity: interest.quantity, position: interest.position }] : [];
    });
    if (interests.length !== canonicalInterests.length) return null;

    // Quote serialization is per lead, but tax defaults are dealer-global.
    // Serialize the empty-check/seed path independently so two first quotes
    // for different leads cannot both create the default rule set.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`dealer-taxes:${currentLead.dealerId}`}))`,
    );
    let taxRules = await tx.select().from(dealerTaxesTable).where(
      eq(dealerTaxesTable.dealerId, currentLead.dealerId),
    ).orderBy(asc(dealerTaxesTable.sortOrder), asc(dealerTaxesTable.id));
    if (!taxRules.length) {
      const today = now.toISOString().slice(0, 10);
      await tx
        .insert(dealerTaxesTable)
        .values(DEFAULT_DEALER_TAXES.map((rule, index) => ({
          dealerId: currentLead.dealerId, ...rule, effectiveFrom: today,
          active: true, sortOrder: index, createdBy: "system",
        })))
        .onConflictDoNothing({
          target: [
            dealerTaxesTable.dealerId,
            dealerTaxesTable.code,
            dealerTaxesTable.effectiveFrom,
          ],
        });
      taxRules = await tx.select().from(dealerTaxesTable).where(
        eq(dealerTaxesTable.dealerId, currentLead.dealerId),
      ).orderBy(asc(dealerTaxesTable.sortOrder), asc(dealerTaxesTable.id));
    }
    const [latest] = await tx
      .select()
      .from(quotesTable)
      .where(and(eq(quotesTable.dealerId, currentLead.dealerId), eq(quotesTable.leadId, currentLead.id)))
      .orderBy(desc(quotesTable.version))
      .limit(1)
      .for("update");
    const latestItems = latest
      ? await tx.select().from(quoteItemsTable).where(eq(quoteItemsTable.quoteId, latest.id)).orderBy(quoteItemsTable.position)
      : [];
    const normalItems = interests.map(({ vehicle, quantity, position }) => {
      const computed = computeTaxes(vehicle.price * quantity, taxRules, { powertrain: vehicle.powertrain });
      const modelYear = opts.overrides?.modelYear ?? vehicle.year;
      const vehicleLine = opts.overrides?.modelName?.trim() ||
        (vehicle.model.toLowerCase().startsWith(vehicle.make.toLowerCase()) ? vehicle.model : `${vehicle.make} ${vehicle.model}`);
      return { vehicle, quantity, position, computed, modelYear, vehicleLine };
    });
    const unchanged = latestItems.length === normalItems.length && latestItems.every((item, index) => {
      const next = normalItems[index]!;
      return item.vehicleId === next.vehicle.id && item.quantity === next.quantity &&
        item.position === next.position && item.basePrice === next.vehicle.price &&
        item.modelYear === next.modelYear && item.vehicleLine === next.vehicleLine &&
        item.trim === (next.vehicle.trim || next.vehicle.variant || currentLead.variant || null) &&
        item.color === (next.vehicle.exteriorColor || currentLead.color || null) &&
        item.manufacturer === next.vehicle.make &&
        JSON.stringify(item.taxLines) === JSON.stringify(next.computed.lines) &&
        item.totalTax === next.computed.totalTax && item.total === next.computed.totalWithTax;
    });
    const dutyFreeApproved = unchanged && latest?.dutyFreeStatus === "approved";
    const approvedDiscount = unchanged && latest?.discountStatus === "approved" ? latest.discountAmount : 0;
    const effectiveRules = dutyFreeApproved ? dutyFreeTaxRules(taxRules) : taxRules;
    const pricedItems = normalItems.map((item) => ({
      ...item,
      computed: computeTaxes(item.vehicle.price * item.quantity, effectiveRules, { powertrain: item.vehicle.powertrain }),
    }));
    const primary = pricedItems[0]!;
    const basePrice = pricedItems.reduce((sum, item) => sum + item.vehicle.price * item.quantity, 0);
    const totalTax = pricedItems.reduce((sum, item) => sum + item.computed.totalTax, 0);
    const total = Math.max(basePrice + totalTax - approvedDiscount, 0);
    let quoteNumber = latest?.quoteNumber;
    if (!quoteNumber) {
      // Quote versioning is lead-scoped, but the public number namespace is
      // dealer-wide. Serialize first-number allocation across distinct leads.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`quote-number:${currentLead.dealerId}`}))`,
      );
      const [numberRow] = await tx.select({
        max: sql<number>`coalesce(max((substring(${quoteNumbersTable.quoteNumber} from '[0-9]+$'))::int), 0)::int`,
      }).from(quoteNumbersTable).where(eq(quoteNumbersTable.dealerId, currentLead.dealerId));
      quoteNumber = `EST-${String((numberRow?.max ?? 0) + 1).padStart(5, "0")}`;
      await tx.insert(quoteNumbersTable).values({
        dealerId: currentLead.dealerId,
        leadId: currentLead.id,
        quoteNumber,
      });
    }
    const version = (latest?.version ?? 0) + 1;
    if (latest) await tx
      .update(quotesTable)
      .set({ status: "superseded" })
      .where(
        and(
          eq(quotesTable.dealerId, currentLead.dealerId),
          eq(quotesTable.leadId, currentLead.id),
          ne(quotesTable.status, "superseded"),
        ),
      );
    const [created] = await tx
    .insert(quotesTable)
    .values({
      dealerId: currentLead.dealerId,
      leadId: currentLead.id,
      // Compatibility projection: the first interest is the primary vehicle.
      vehicleId: primary.vehicle.id,
      quoteNumber,
      version,
      status: "current",
      customerName: currentLead.name,
      customerAddress: currentLead.address,
      modelYear: primary.modelYear,
      vehicleLine: primary.vehicleLine,
      trim: primary.vehicle.trim || primary.vehicle.variant || currentLead.variant || null,
      color: primary.vehicle.exteriorColor || currentLead.color || null,
      manufacturer: primary.vehicle.make,
      mfgDate: String(primary.modelYear),
      quantity: pricedItems.reduce((sum, item) => sum + item.quantity, 0),
      basePrice,
      // Compatibility projection: aggregate tax lines are retained alongside
      // canonical item lines so existing renderers and approval gates work.
      taxLines: pricedItems.flatMap((item) => item.computed.lines),
      totalTax,
      total,
       requestType: dutyFreeApproved ? "duty_free" : requestType,
       dutyFreeStatus: dutyFreeApproved ? "approved" : requestType === "duty_free" ? "pending" : "none",
       ...(approvedDiscount > 0
         ? { discountAmount: Math.min(approvedDiscount, Math.max(basePrice + totalTax - 1, 0)), discountStatus: "approved" }
         : {}),
      taxSnapshot: pricedItems.flatMap((item) => item.computed.lines),
      issuedOn: longDate(now),
      validUntil: longDate(validUntil),
      trigger: opts.trigger,
      createdBy: opts.actor,
      isAgent: opts.isAgent,
    })
    .returning();
    // Item rows preserve the full pre-authority commercial snapshot used for
    // staleness comparison. The parent header carries the approved effective
    // duty-free/discount presentation.
    await tx.insert(quoteItemsTable).values(normalItems.map((item) => ({
      dealerId: currentLead.dealerId, quoteId: created!.id, vehicleId: item.vehicle.id,
      quantity: item.quantity, position: item.position, modelYear: item.modelYear,
      vehicleLine: item.vehicleLine,
      trim: item.vehicle.trim || item.vehicle.variant || currentLead.variant || null,
      color: item.vehicle.exteriorColor || currentLead.color || null,
      manufacturer: item.vehicle.make, basePrice: item.vehicle.price,
      taxLines: item.computed.lines, totalTax: item.computed.totalTax,
      total: item.computed.totalWithTax,
    })));
    return { quote: created!, pricedItems, totalTax, basePrice, total, quoteNumber, version, lead: currentLead };
  });
  if (!committed) return null;
  const { quote, pricedItems, totalTax, basePrice, total, quoteNumber, version, lead: committedLead } = committed;

  const taxSummary =
    totalTax > 0
      ? pricedItems.flatMap((item) => item.computed.lines)
          .map((l) => `${l.name} $${l.amount.toLocaleString("en-US")}`)
          .join(", ")
      : "no taxes applicable";
  const detail =
    `${quoteNumber} rev ${version} — ${pricedItems.length} vehicle interest(s), ` +
    `base $${basePrice.toLocaleString("en-US")}, ${taxSummary}, total $${total.toLocaleString("en-US")}.`;

  if (opts.isAgent) {
    await recordAgentRun({
      dealerId: committedLead.dealerId,
      agentKey: "quote_tax",
      runType: "quote_generation",
      autonomy: "system",
      inputSource: "quotes",
      inputSummary: `Lead #${committedLead.id}, trigger=${opts.trigger}`,
      outputSummary: detail,
      refType: "quote",
      refId: quote?.id ?? null,
      mutation: true,
    });
  }

  await db.insert(timelineEventsTable).values({
    dealerId: committedLead.dealerId,
    customerId: committedLead.customerId,
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
    refId: committedLead.id,
  });

  if (opts.isAgent) {
    await db.insert(activityTable).values({
      dealerId: committedLead.dealerId,
      agentKey: AGENT_KEY,
      actor: QUOTE_AGENT_ACTOR,
      isAi: false,
      action: version === 1 ? "Generated quotation Code" : "Regenerated quotation Code",
      entity: committedLead.name,
      detail,
    });
  }

  return quote;
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
/**
 * Manager-approved discount on the lead's CURRENT quote (0 when none).
 * Deals desked for the lead seed their discount from this so the customer's
 * approved quote price carries into the deal instead of the list price.
 */
export async function approvedQuoteDiscountForLead(
  dealerId: number,
  leadId: number,
): Promise<number> {
  const [quote] = await db
    .select({ discountAmount: quotesTable.discountAmount })
    .from(quotesTable)
    .where(
      and(
        eq(quotesTable.dealerId, dealerId),
        eq(quotesTable.leadId, leadId),
        eq(quotesTable.status, "current"),
        eq(quotesTable.discountStatus, "approved"),
      ),
    )
    .orderBy(desc(quotesTable.version))
    .limit(1);
  return quote?.discountAmount ?? 0;
}

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

export async function withQuoteItems<T extends Quote>(quotes: T[]): Promise<Array<T & { items: import("@workspace/db").QuoteItem[] }>> {
  if (!quotes.length) return [];
  const items = await db.select().from(quoteItemsTable).where(inArray(
    quoteItemsTable.quoteId, quotes.map((quote) => quote.id),
  )).orderBy(quoteItemsTable.position);
  const byQuote = new Map<number, typeof items>();
  for (const item of items) byQuote.set(item.quoteId, [...(byQuote.get(item.quoteId) ?? []), item]);
  return quotes.map((quote) => ({ ...quote, items: byQuote.get(quote.id) ?? [] }));
}

/** Map a stored quote to the string payload the PDF builder + email queue expect. */
export async function quotePdfPayload(
  quote: Quote,
): Promise<Record<string, string>> {
  const money = (n: number) =>
    n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const [dealer] = await db
    .select({
      name: dealersTable.name,
      brandName: dealersTable.brandName,
      address: dealersTable.address,
      city: dealersTable.city,
      country: dealersTable.country,
      tin: dealersTable.tin,
      servicePhone: dealersTable.servicePhone,
    })
    .from(dealersTable)
    .where(eq(dealersTable.id, quote.dealerId))
    .limit(1);
  const gyd = (n: number) => `GYD ${money(n)}`;
  const items = await db.select().from(quoteItemsTable).where(
    eq(quoteItemsTable.quoteId, quote.id),
  ).orderBy(quoteItemsTable.position);
  // A pre-normalization historical quote has no item rows; retain a single
  // compatibility line rather than failing to render the document.
  const printableItems = items.length ? items : [{
    id: 0, vehicleLine: quote.vehicleLine, manufacturer: quote.manufacturer,
    modelYear: quote.modelYear, trim: quote.trim, color: quote.color,
    quantity: quote.quantity, basePrice: quote.basePrice / Math.max(quote.quantity, 1),
    totalTax: quote.totalTax, total: quote.basePrice + quote.totalTax,
  }];
  return {
    totalGyd: gyd(quote.total),
    dealerName: dealer?.brandName ?? dealer?.name ?? "",
    dealerAddress:
      dealer?.address ??
      [dealer?.city, dealer?.country].filter(Boolean).join(", "),
    dealerTin: dealer?.tin ?? "",
    dealerPhone: dealer?.servicePhone ?? "",
    exchangeRateNote: "All figures in GYD",
    name: quote.customerName,
    address: quote.customerAddress ?? "",
    vehicle: quote.vehicleLine,
    model: quote.vehicleLine,
    modelYear: String(quote.modelYear),
    manufacturer: quote.manufacturer,
    mfgDate: quote.mfgDate ?? "",
    version: quote.trim ?? "Standard specification",
    color: quote.color ?? "",
    quantity: String(quote.quantity),
    unitPrice: money(quote.basePrice),
    subtotal: money(quote.basePrice),
    quoteItems: JSON.stringify(printableItems.map((item) => ({
      model: item.vehicleLine, manufacturer: item.manufacturer,
      year: item.modelYear, variant: item.trim ?? "", color: item.color ?? "",
      quantity: item.quantity, unitPrice: money(item.basePrice),
      subtotal: money(item.basePrice * item.quantity), tax: money(item.totalTax),
      total: money(item.total),
    }))),
    approvedTreatments: JSON.stringify([
      ...(quote.discountStatus === "approved" ? ["Discount — Approved"] : []),
      ...(quote.dutyFreeStatus === "approved" ? ["Duty Free — Approved"] : []),
    ]),
    taxLines: JSON.stringify([
      ...quote.taxLines.map((l) => ({
        name: l.kind === "percent" ? `${l.name} (${l.rate}%)` : l.name,
        amount: money(l.amount),
      })),
      // Management-approved discount shows as its own line on the quote.
      ...(quote.discountAmount > 0 && quote.discountStatus === "approved"
        ? [{ name: "Discount (approved)", amount: `-${money(quote.discountAmount)}` }]
        : []),
    ]),
    totalTax: money(quote.totalTax),
    total: money(quote.total),
    quoteRef: `${quote.quoteNumber}-R${quote.version}`,
    issuedOn: quote.issuedOn,
    validUntil: quote.validUntil,
  };
}
