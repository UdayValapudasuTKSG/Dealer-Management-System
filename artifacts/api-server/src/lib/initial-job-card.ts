import { and, eq, sql } from "drizzle-orm";
import {
  db,
  customersTable,
  jobCardsTable,
  serviceOrdersTable,
} from "@workspace/db";
import { getServiceSettings } from "./service-settings";
import {
  calculateLabourRateGyd,
  labourUsdPerHourForBrand,
} from "./service-labour-pricing";
import { computeServiceTax, ensureDealerTaxes } from "./taxes";

type ServiceOrder = typeof serviceOrdersTable.$inferSelect;
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function computeLateSurcharge(order: ServiceOrder): Promise<{
  surchargeStatus?: string;
  surchargeAmount?: number;
  surchargeOverKm?: number;
}> {
  if (order.odometer == null) return {};
  const settings = await getServiceSettings(order.dealerId);
  const priorFilter = order.vehicleId != null
    ? eq(serviceOrdersTable.vehicleId, order.vehicleId)
    : order.customerId != null
      ? and(
          eq(serviceOrdersTable.customerId, order.customerId),
          eq(serviceOrdersTable.vehicleInfo, order.vehicleInfo),
        )
      : undefined;
  if (!priorFilter) return {};
  const [prior] = await db
    .select({ lastOdo: sql<number | null>`max(${serviceOrdersTable.odometer})` })
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.dealerId, order.dealerId),
        priorFilter,
        sql`${serviceOrdersTable.id} <> ${order.id}`,
        sql`${serviceOrdersTable.status} in ('resolved', 'closed')`,
        sql`${serviceOrdersTable.odometer} is not null`,
      ),
    );
  if (prior?.lastOdo == null) return {};
  const overKm =
    order.odometer - Number(prior.lastOdo) - settings.serviceIntervalKm;
  if (overKm <= 0) return {};
  return {
    surchargeStatus: "suggested",
    surchargeAmount: settings.lateSurchargeFee,
    surchargeOverKm: overKm,
  };
}

export async function initialJobCardQuoteTotal(input: {
  dealerId: number;
  quotedLaborHours: number;
  laborRate: number;
  surchargeStatus?: string;
  surchargeAmount?: number;
}): Promise<number> {
  const labour =
    Math.round(input.quotedLaborHours * input.laborRate * 100) / 100;
  const surcharge =
    input.surchargeStatus === "applied"
      ? Math.round((input.surchargeAmount ?? 0) * 100) / 100
      : 0;
  return computeServiceTax(
    Math.round((labour + surcharge) * 100) / 100,
    await ensureDealerTaxes(input.dealerId),
  ).total;
}

/**
 * Creates the one initial card belonging to a service booking.
 *
 * Callers must pass the transaction that inserted/read the booking. The
 * dealer+order advisory lock makes catch-up and normal intake safe to race.
 * Existing cards are returned unchanged; no approvals, work, or timer state is
 * synthesized.
 */
export async function ensureInitialJobCard(
  tx: DbTransaction,
  order: ServiceOrder,
  options?: { scheduledAt?: Date | null },
): Promise<typeof jobCardsTable.$inferSelect | null> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`initial-job-card-${order.dealerId}-${order.id}`}))`,
  );
  const [existing] = await tx
    .select()
    .from(jobCardsTable)
    .where(
      and(
        eq(jobCardsTable.dealerId, order.dealerId),
        eq(jobCardsTable.serviceOrderId, order.id),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const surcharge = await computeLateSurcharge(order);
  const settings = await getServiceSettings(order.dealerId);
  const laborHours = order.estimatedHours;
  const quotedLaborHours = laborHours;
  const laborRate = calculateLabourRateGyd(
    settings.labourUsdToGydRate,
    labourUsdPerHourForBrand(order.brand, settings.brandLabourRates),
  );
  const quoteTotal = await initialJobCardQuoteTotal({
    dealerId: order.dealerId,
    quotedLaborHours,
    laborRate,
    ...surcharge,
  });
  let customerPhoneSnapshot = order.customerPhoneSnapshot;
  if (customerPhoneSnapshot == null && order.customerId != null) {
    const [customer] = await tx
      .select({ phone: customersTable.phone })
      .from(customersTable)
      .where(
        and(
          eq(customersTable.id, order.customerId),
          eq(customersTable.dealerId, order.dealerId),
        ),
      )
      .limit(1);
    customerPhoneSnapshot = customer?.phone ?? null;
  }

  const [created] = await tx
    .insert(jobCardsTable)
    .values({
      dealerId: order.dealerId,
      serviceOrderId: order.id,
      assetId: order.assetId ?? null,
      title:
        order.complaint?.trim() ||
        `${order.type.replace(/_/g, " ")} — ${order.vehicleInfo}`,
      status: "open",
      payType: order.payType,
      technicianUserId: order.technicianUserId,
      technicianName: order.technician,
      scheduledAt:
        options && "scheduledAt" in options
          ? options.scheduledAt
          : new Date(`${order.scheduledDate}T09:00:00`),
      durationMins: Math.round(order.estimatedHours * 60),
      laborHours,
      quotedLaborHours,
      laborRate,
      quoteTotal,
      customerPhoneSnapshot,
      ...surcharge,
    })
    // The partial active-asset uniqueness rule may legitimately prevent a
    // second open card for the same vehicle. The booking remains intact and
    // can be opened after the active work is closed.
    .onConflictDoNothing()
    .returning();
  return created ?? null;
}