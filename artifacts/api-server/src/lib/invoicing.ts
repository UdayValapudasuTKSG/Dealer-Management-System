import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  db,
  bookingsTable,
  dealersTable,
  financeApplicationsTable,
  invoicesTable,
  paymentsTable,
  receiptsTable,
  timelineEventsTable,
  vehiclesTable,
  type Deal,
  type Invoice,
  type InvoiceKind,
  type InvoiceTaxLine,
} from "@workspace/db";
import { computeTaxes, ensureDealerTaxes } from "./taxes";
import { logger } from "./logger";

/**
 * Invoicing + payment ledger helpers (L6). All amounts USD-scale; each
 * invoice/receipt snapshots the dealer's exchange rate so historical GYD
 * display stays reproducible after rate changes. Deterministic — no LLM
 * touches money.
 */

export async function dealerExchangeRate(dealerId: number): Promise<number> {
  const [dealer] = await db
    .select({ rate: dealersTable.usdExchangeRate })
    .from(dealersTable)
    .where(eq(dealersTable.id, dealerId));
  return dealer?.rate ?? 209;
}

export type IssueInvoiceArgs = {
  dealerId: number;
  kind: InvoiceKind;
  customerName: string;
  amount: number;
  customerId?: number | null;
  dealId?: number | null;
  applicationId?: number | null;
  description?: string | null;
  dueDate?: string | null;
  taxLines?: InvoiceTaxLine[];
};

/** Insert an issued invoice with a sequential number + rate snapshot. */
export async function issueInvoice(args: IssueInvoiceArgs): Promise<Invoice> {
  const exchangeRate = await dealerExchangeRate(args.dealerId);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(invoicesTable)
      .values({
        dealerId: args.dealerId,
        invoiceNumber: "PENDING",
        customerId: args.customerId ?? null,
        customerName: args.customerName,
        dealId: args.dealId ?? null,
        applicationId: args.applicationId ?? null,
        description: args.description ?? null,
        amount: Math.round(args.amount * 100) / 100,
        kind: args.kind,
        status: "issued",
        dueDate: args.dueDate ?? null,
        taxLines: args.taxLines ?? [],
        currency: "USD",
        exchangeRate,
      })
      .returning();
    const [numbered] = await tx
      .update(invoicesTable)
      .set({
        invoiceNumber: `INV-${new Date().getFullYear()}-${String(row!.id).padStart(4, "0")}`,
      })
      .where(eq(invoicesTable.id, row!.id))
      .returning();
    return numbered!;
  });
}

/** Sum of payments applied to an invoice. */
export async function invoicePaidTotal(invoiceId: number): Promise<number> {
  const [{ paid }] = await db
    .select({
      paid: sql<number>`coalesce(sum(${paymentsTable.amount}), 0)::float`,
    })
    .from(paymentsTable)
    .where(eq(paymentsTable.invoiceId, invoiceId));
  return paid;
}

export type ApplyPaymentArgs = {
  invoice: Invoice;
  amount: number;
  method: string;
  reference?: string | null;
  receivedBy?: string | null;
  confirmDuplicate?: boolean;
};

/**
 * Raised by applyPayment when a transactional guard fails; the route maps
 * `code` to the appropriate HTTP status + body.
 */
export class PaymentGuardError extends Error {
  constructor(
    public code:
      | "invoice_void"
      | "invoice_already_paid"
      | "reversal_exceeds_paid"
      | "overpayment"
      | "duplicate_reference",
    public extra: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "PaymentGuardError";
  }
}

/**
 * Record a payment inside one transaction: ledger row, invoice status
 * recompute (issued → partially_paid → paid), and a receipt with the
 * currency + exchange-rate snapshot. All monetary guards run INSIDE the
 * transaction while holding a row lock on the invoice, so concurrent
 * postings serialize and cannot overpay, over-reverse, or slip a
 * duplicate reference past the guard (throws PaymentGuardError).
 */
export async function applyPayment(args: ApplyPaymentArgs) {
  const { invoice } = args;
  const exchangeRate = await dealerExchangeRate(invoice.dealerId);
  return db.transaction(async (tx) => {
    // Serialize concurrent postings against this invoice.
    const [locked] = await tx
      .select()
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.id, invoice.id),
          eq(invoicesTable.dealerId, invoice.dealerId),
        ),
      )
      .for("update");
    if (!locked || locked.status === "void") {
      throw new PaymentGuardError("invoice_void");
    }
    const isReversal = args.amount < 0;
    if (locked.status === "paid" && !isReversal) {
      throw new PaymentGuardError("invoice_already_paid");
    }

    const reference = args.reference?.trim() || null;
    if (reference) {
      // Advisory xact lock keyed on (dealer, reference) serializes the
      // duplicate-reference check across invoices for this dealer.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${invoice.dealerId}:${reference}`}))`,
      );
    }

    const [{ paid: alreadyPaid }] = await tx
      .select({
        paid: sql<number>`coalesce(sum(${paymentsTable.amount}), 0)::float`,
      })
      .from(paymentsTable)
      .where(eq(paymentsTable.invoiceId, invoice.id));

    if (isReversal) {
      const after = Math.round((alreadyPaid! + args.amount) * 100) / 100;
      if (after < 0) {
        throw new PaymentGuardError("reversal_exceeds_paid", {
          paid: alreadyPaid,
        });
      }
    } else {
      const excess =
        Math.round((alreadyPaid! + args.amount - locked.amount) * 100) / 100;
      if (excess > 0) {
        throw new PaymentGuardError("overpayment", { excess });
      }
      if (reference && !args.confirmDuplicate) {
        const [dupe] = await tx
          .select({ id: paymentsTable.id })
          .from(paymentsTable)
          .where(
            and(
              eq(paymentsTable.dealerId, invoice.dealerId),
              eq(paymentsTable.reference, reference),
            ),
          );
        if (dupe) {
          throw new PaymentGuardError("duplicate_reference", {
            existingPaymentId: dupe.id,
          });
        }
      }
    }

    const [row] = await tx
      .insert(paymentsTable)
      .values({
        dealerId: invoice.dealerId,
        invoiceId: invoice.id,
        customerName: invoice.customerName,
        amount: args.amount,
        method: args.method,
        reference: args.reference ?? null,
        receivedBy: args.receivedBy ?? null,
      })
      .returning();

    const [{ paid }] = await tx
      .select({
        paid: sql<number>`coalesce(sum(${paymentsTable.amount}), 0)::float`,
      })
      .from(paymentsTable)
      .where(eq(paymentsTable.invoiceId, invoice.id));

    const status =
      paid >= invoice.amount - 0.005
        ? "paid"
        : paid <= 0.005
          ? "issued"
          : "partially_paid";
    await tx
      .update(invoicesTable)
      .set({ status })
      .where(
        and(
          eq(invoicesTable.id, invoice.id),
          eq(invoicesTable.dealerId, invoice.dealerId),
        ),
      );

    const [receipt] = await tx
      .insert(receiptsTable)
      .values({
        dealerId: invoice.dealerId,
        receiptNumber: `RCT-${new Date().getFullYear()}-${String(row!.id).padStart(4, "0")}`,
        paymentId: row!.id,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        customerName: invoice.customerName,
        amount: row!.amount,
        method: row!.method,
        currency: "USD",
        exchangeRate,
        issuedBy: args.receivedBy ?? null,
      })
      .returning();

    return { payment: row!, receipt: receipt!, invoiceStatus: status, paid };
  });
}

/** Reservation fee credit for a deal: paid amounts on matching bookings. */
async function reservationCreditForDeal(deal: Deal): Promise<number> {
  const rows = await db
    .select({ amountPaid: bookingsTable.amountPaid })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.dealerId, deal.dealerId),
        inArray(bookingsTable.status, ["active", "converted"]),
        or(
          eq(bookingsTable.dealId, deal.id),
          and(
            eq(bookingsTable.vehicleId, deal.vehicleId),
            deal.customerId != null
              ? eq(bookingsTable.customerId, deal.customerId)
              : eq(bookingsTable.customerName, deal.customerName ?? ""),
          ),
        ),
      ),
    );
  return rows.reduce((s, r) => s + (r.amountPaid ?? 0), 0);
}

/** Latest approved/disbursed finance application linked to the deal. */
export async function approvedFinanceAppForDeal(deal: Deal) {
  const [app] = await db
    .select()
    .from(financeApplicationsTable)
    .where(
      and(
        eq(financeApplicationsTable.dealerId, deal.dealerId),
        eq(financeApplicationsTable.dealId, deal.id),
        inArray(financeApplicationsTable.status, ["approved", "disbursed"]),
      ),
    )
    .orderBy(desc(financeApplicationsTable.createdAt));
  return app ?? null;
}

/**
 * Dual-invoice #2 (L6): auto-generate the FINAL invoice when a deal commits.
 * amount = otdPrice − reservation fee paid − tradeInValue − financed/down
 * portion (bank pays the financed facility directly). Tax lines are the
 * dealer_taxes snapshot recomputed at commit time. Idempotent per deal —
 * an existing non-void final invoice short-circuits.
 */
export async function ensureFinalInvoiceForDeal(
  deal: Deal,
): Promise<Invoice | null> {
  const [existing] = await db
    .select()
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.dealerId, deal.dealerId),
        eq(invoicesTable.dealId, deal.id),
        eq(invoicesTable.kind, "final"),
        inArray(invoicesTable.status, ["issued", "partially_paid", "paid"]),
      ),
    );
  if (existing) return existing;

  const reservationCredit = await reservationCreditForDeal(deal);
  const financedApp =
    deal.finalPaymentMethod === "bank_financing"
      ? await approvedFinanceAppForDeal(deal)
      : null;
  const financedCredit = financedApp?.amount ?? 0;

  const [vehicle] = await db
    .select()
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.id, deal.vehicleId),
        eq(vehiclesTable.dealerId, deal.dealerId),
      ),
    );
  const taxBase = Math.max(
    deal.vehiclePrice - deal.discount + deal.accessories,
    0,
  );
  const taxRules = await ensureDealerTaxes(deal.dealerId);
  const { lines } = computeTaxes(taxBase, taxRules, {
    powertrain: vehicle?.powertrain ?? null,
  });

  const net = Math.max(
    Math.round(
      (deal.otdPrice - reservationCredit - deal.tradeInValue - financedCredit) *
        100,
    ) / 100,
    0,
  );

  const credits: string[] = [];
  if (reservationCredit > 0)
    credits.push(`reservation fee $${reservationCredit.toLocaleString("en-US")}`);
  if (deal.tradeInValue > 0)
    credits.push(`trade-in $${deal.tradeInValue.toLocaleString("en-US")}`);
  if (financedCredit > 0)
    credits.push(
      `financed facility $${financedCredit.toLocaleString("en-US")} (${financedApp?.lender ?? "bank"})`,
    );

  const vehicleName = vehicle
    ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`
    : `vehicle #${deal.vehicleId}`;
  return issueInvoice({
    dealerId: deal.dealerId,
    kind: "final",
    customerName: deal.customerName ?? "Customer",
    amount: net,
    customerId: deal.customerId,
    dealId: deal.id,
    applicationId: financedApp?.id ?? null,
    description:
      `Final settlement — ${vehicleName} (deal #${deal.id}). ` +
      `OTD $${deal.otdPrice.toLocaleString("en-US")}` +
      (credits.length ? ` less ${credits.join(", ")}` : ""),
    taxLines: lines,
  });
}

/** Best-effort payment timeline receipt on the linked customer. */
export async function logPaymentEvent(
  invoice: Invoice,
  amount: number,
  method: string,
  receiptNumber: string,
): Promise<void> {
  if (invoice.customerId == null) return;
  try {
    await db.insert(timelineEventsTable).values({
      dealerId: invoice.dealerId,
      customerId: invoice.customerId,
      domain: "finance",
      kind: "payment_recorded",
      title: `Payment received — ${invoice.invoiceNumber}`,
      detail: `$${amount.toLocaleString("en-US")} via ${method.replace(/_/g, " ")} (receipt ${receiptNumber})`,
      actor: "AURA",
      isAgent: false,
      refType: "invoice",
      refId: invoice.id,
    });
  } catch (err) {
    logger.error({ err, invoiceId: invoice.id }, "payment timeline event failed");
  }
}
