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
import { enqueueEmail } from "./email";
import { dealerTimezone, zonedParts } from "./timezone";
import {
  resolveSalesAdvisorName,
  snapshotSalesAdvisorPayload,
  type SalesAdvisorLead,
} from "./sales-advisor";

// ---------------------------------------------------------------------------
// Quote agent (A3) — auto-generates the GT-format "Code" (estimate) for every
// lead with a vehicle of interest, priced deterministically from inventory
// with the dealer's configured taxes applied. Plain code, never an LLM.
// Sequential per-dealer estimate numbers; regenerations create new versions
// and prior versions are always retained.
// ---------------------------------------------------------------------------

export const QUOTE_AGENT_ACTOR = "AURA System";
const AGENT_KEY = "quote_tax";
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const longDate = (d: Date, tz: string) => {
  const p = zonedParts(d, tz);
  return `${MONTHS[p.month - 1]} ${p.day}, ${p.year}`;
};

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
  const tz = await dealerTimezone(lead.dealerId);
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
    let canonicalInterests = interestRows;
    if (!canonicalInterests.length && currentLead.interestedVehicleId) {
      const [legacy] = await tx.select().from(vehiclesTable).where(and(
        eq(vehiclesTable.id, currentLead.interestedVehicleId),
        eq(vehiclesTable.dealerId, currentLead.dealerId),
      ));
      canonicalInterests = legacy ? [{
        id: 0, dealerId: currentLead.dealerId, leadId: currentLead.id,
        vehicleId: legacy.id, make: legacy.make, model: legacy.model,
        modelYear: legacy.year, variant: legacy.trim ?? legacy.variant,
        color: legacy.exteriorColor, unitPrice: legacy.price,
        quantity: 1, position: 0, createdAt: now,
      }] : [];
    }
    if (!canonicalInterests.length) return null;
    // Read inventory only for tax classification. It is not selected, locked,
    // held, or persisted as the requested unit.
    const inventory = await tx.select().from(vehiclesTable).where(
      eq(vehiclesTable.dealerId, currentLead.dealerId),
    );
    const interests = canonicalInterests.map((interest) => ({
      interest,
      representative: inventory.find((vehicle) =>
        vehicle.make.toLowerCase() === interest.make.toLowerCase() &&
        vehicle.model.toLowerCase() === interest.model.toLowerCase() &&
        vehicle.year === interest.modelYear &&
        (vehicle.trim ?? vehicle.variant ?? "Base").toLowerCase() === (interest.variant ?? "Base").toLowerCase() &&
        (vehicle.exteriorColor ?? "").toLowerCase() === (interest.color ?? "").toLowerCase()
      ),
    }));

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
    const normalItems = interests.map(({ interest, representative }) => {
      const computed = computeTaxes(interest.unitPrice * interest.quantity, taxRules, { powertrain: representative?.powertrain });
      const modelYear = opts.overrides?.modelYear ?? interest.modelYear;
      const vehicleLine = opts.overrides?.modelName?.trim() ||
        (interest.model.toLowerCase().startsWith(interest.make.toLowerCase()) ? interest.model : `${interest.make} ${interest.model}`);
      return { interest, representative, quantity: interest.quantity, position: interest.position, computed, modelYear, vehicleLine };
    });
    const comparisonRules =
      latest?.dutyFreeStatus === "approved"
        ? dutyFreeTaxRules(taxRules)
        : taxRules;
    const comparisonItems = normalItems.map((item) => ({
      ...item,
      computed: computeTaxes(
        item.interest.unitPrice * item.quantity,
        comparisonRules,
        { powertrain: item.representative?.powertrain },
      ),
    }));
    const unchanged = latestItems.length === comparisonItems.length && latestItems.every((item, index) => {
      const next = comparisonItems[index]!;
       return item.vehicleId === (next.interest.vehicleId ?? null) && item.make === next.interest.make &&
        item.model === next.interest.model && item.quantity === next.quantity &&
        item.position === next.position && item.basePrice === next.interest.unitPrice &&
        item.modelYear === next.modelYear && item.vehicleLine === next.vehicleLine &&
        item.trim === (next.interest.variant || currentLead.variant || null) &&
        item.color === (next.interest.color || currentLead.color || null) &&
        item.manufacturer === next.interest.make &&
        JSON.stringify(item.taxLines) === JSON.stringify(next.computed.lines) &&
        item.totalTax === next.computed.totalTax && item.total === next.computed.totalWithTax;
    });
    const dutyFreeApproved = unchanged && latest?.dutyFreeStatus === "approved";
    const approvedDiscount = unchanged && latest?.discountStatus === "approved" ? latest.discountAmount : 0;
    const effectiveRules = dutyFreeApproved ? dutyFreeTaxRules(taxRules) : taxRules;
    const pricedItems = normalItems.map((item) => ({
      ...item,
       computed: computeTaxes(item.interest.unitPrice * item.quantity, effectiveRules, { powertrain: item.representative?.powertrain }),
    }));
    const primary = pricedItems[0]!;
    const basePrice = pricedItems.reduce((sum, item) => sum + item.interest.unitPrice * item.quantity, 0);
    const totalTax = pricedItems.reduce((sum, item) => sum + item.computed.totalTax, 0);
    const total = Math.max(basePrice + totalTax - approvedDiscount, 0);
    // A retried lead-created event must reuse the one canonical revision. The
    // advisory lock makes this atomic; the stable quote id then also makes the
    // email outbox dedupe key stable.
    if (
      opts.trigger === "lead_created" &&
      latest?.trigger === "lead_created" &&
      unchanged
    ) {
      return {
        quote: latest,
        pricedItems,
        totalTax: latest.totalTax,
        basePrice: latest.basePrice,
        total: latest.total,
        quoteNumber: latest.quoteNumber,
        version: latest.version,
        lead: currentLead,
        createdNew: false,
      };
    }
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
       // Historical provenance only. New specification-backed quotes never
       // project an inventory representative into the commercial snapshot.
       vehicleId: primary.interest.vehicleId ?? null,
      quoteNumber,
      version,
      status: "current",
      customerName: currentLead.name,
      customerAddress: currentLead.address,
      modelYear: primary.modelYear,
      vehicleLine: primary.vehicleLine,
       trim: primary.interest.variant || currentLead.variant || null,
       color: primary.interest.color || currentLead.color || null,
       manufacturer: primary.interest.make,
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
      issuedOn: longDate(now, tz),
      validUntil: longDate(validUntil, tz),
      trigger: opts.trigger,
      createdBy: opts.actor,
      isAgent: opts.isAgent,
    })
    .returning();
    // Item rows and the header preserve the same effective commercial
    // snapshot, including approved Duty Free treatment.
    await tx.insert(quoteItemsTable).values(pricedItems.map((item) => ({
       dealerId: currentLead.dealerId, quoteId: created!.id,
        vehicleId: item.interest.vehicleId ?? null,
       make: item.interest.make, model: item.interest.model,
      quantity: item.quantity, position: item.position, modelYear: item.modelYear,
      vehicleLine: item.vehicleLine,
       trim: item.interest.variant || currentLead.variant || null,
       color: item.interest.color || currentLead.color || null,
       manufacturer: item.interest.make, basePrice: item.interest.unitPrice,
      taxLines: item.computed.lines, totalTax: item.computed.totalTax,
      total: item.computed.totalWithTax,
    })));
    return {
      quote: created!,
      pricedItems,
      totalTax,
      basePrice,
      total,
      quoteNumber,
      version,
      lead: currentLead,
      createdNew: true,
    };
  });
  if (!committed) return null;
  const {
    quote,
    pricedItems,
    totalTax,
    basePrice,
    total,
    quoteNumber,
    version,
    lead: committedLead,
    createdNew,
  } = committed;

  const taxSummary =
    totalTax > 0
      ? pricedItems.flatMap((item) => item.computed.lines)
          .map((l) => `${l.name} $${l.amount.toLocaleString("en-US")}`)
          .join(", ")
      : "no taxes applicable";
  const detail =
    `${quoteNumber} rev ${version} — ${pricedItems.length} vehicle interest(s), ` +
    `base $${basePrice.toLocaleString("en-US")}, ${taxSummary}, total $${total.toLocaleString("en-US")}.`;

  if (opts.isAgent && createdNew) {
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

  if (createdNew) {
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
  }

  if (opts.isAgent && createdNew) {
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

  // Lead-created quotes are not merely generated: when an email address is
  // available, queue the exact stored revision for delivery automatically.
  // The quote id in the dedupe key makes retries safe without suppressing a
  // later regenerated revision.
  if (opts.trigger === "lead_created" && committedLead.email) {
    await enqueueEmail({
      template: "vehicle_quote",
      to: committedLead.email,
      dealerId: committedLead.dealerId,
      customerId: committedLead.customerId,
      leadId: committedLead.id,
      data: {
        ...(await quotePdfPayload(quote, committedLead)),
        quoteId: String(quote.id),
        leadId: String(committedLead.id),
      },
      dedupeKey: `lead:${committedLead.id}:quote:${quote.id}:email:v1`,
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
  authorizedLead?: SalesAdvisorLead & Pick<Lead, "id">,
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
  // Canonical callers already hold the dealer-authorized lead.  The fallback
  // lookup keeps this shared payload safe for background callers while still
  // scoping ownership to the quote's dealer.
  const lead =
    (authorizedLead &&
    authorizedLead.id === quote.leadId &&
    authorizedLead.dealerId === quote.dealerId
      ? authorizedLead
      : undefined) ??
    (await db
      .select({
        dealerId: leadsTable.dealerId,
        ownerUserId: leadsTable.ownerUserId,
        assignedTo: leadsTable.assignedTo,
      })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.id, quote.leadId),
          eq(leadsTable.dealerId, quote.dealerId),
        ),
      )
      .limit(1))[0];
  const salesAdvisorName = lead
    ? await resolveSalesAdvisorName(lead)
    : "";
  const payload = {
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
  return snapshotSalesAdvisorPayload(payload, salesAdvisorName);
}
