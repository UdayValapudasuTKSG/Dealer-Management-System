import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  dealsTable,
  vehiclesTable,
  bookingsTable,
  deliveriesTable,
  timelineEventsTable,
  usersTable,
  dealerUsersTable,
  rolePermissionsTable,
  defaultDeliverySteps,
  DEFAULT_PDI_ITEMS,
  type Delivery,
} from "@workspace/db";
import { notifyUsers } from "./email";
import { logger } from "./logger";

async function deliveryUserIds(dealerId: number): Promise<number[]> {
  const rows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .innerJoin(dealerUsersTable, eq(dealerUsersTable.userId, usersTable.id))
    .innerJoin(
      rolePermissionsTable,
      eq(rolePermissionsTable.roleId, dealerUsersTable.roleId),
    )
    .where(
      and(
        eq(dealerUsersTable.dealerId, dealerId),
        eq(rolePermissionsTable.module, "deliveries"),
        inArray(rolePermissionsTable.category, ["view", "admin"]),
        eq(usersTable.status, "active"),
      ),
    );
  return [...new Set(rows.map((r) => r.id))];
}

/**
 * Starts the delivery workflow for a deal (idempotent — one delivery per
 * deal). Triggered when financing is approved or a cash deal is committed.
 * Returns the existing delivery when one is already open.
 */
export async function ensureDeliveryForDeal(
  dealId: number,
  opts: { advisorUserId?: number | null; cause?: string } = {},
): Promise<Delivery | null> {
  const [existing] = await db
    .select()
    .from(deliveriesTable)
    .where(eq(deliveriesTable.dealId, dealId));
  if (existing) return existing;

  const [deal] = await db
    .select()
    .from(dealsTable)
    .where(eq(dealsTable.id, dealId));
  if (!deal || !deal.vehicleId) return null;

  const [booking] = await db
    .select({ id: bookingsTable.id })
    .from(bookingsTable)
    .where(
      and(eq(bookingsTable.dealId, dealId), eq(bookingsTable.status, "active")),
    );

  const [delivery] = await db
    .insert(deliveriesTable)
    .values({
      dealerId: deal.dealerId,
      dealId,
      bookingId: booking?.id ?? null,
      vehicleId: deal.vehicleId,
      customerId: deal.customerId ?? null,
      customerName: deal.customerName,
      advisorUserId: opts.advisorUserId ?? null,
      status: "in_progress",
      currentStep: "sales_order",
      steps: defaultDeliverySteps(),
      pdiItems: DEFAULT_PDI_ITEMS,
    })
    .returning();
  if (!delivery) return null;

  try {
    await db.insert(timelineEventsTable).values({
      dealerId: deal.dealerId,
      customerId: deal.customerId ?? null,
      domain: "delivery",
      kind: "delivery_started",
      title: "Delivery workflow started",
      detail: `11-step delivery workflow opened for ${deal.customerName} on deal #${dealId}.`,
      actor: "AURA orchestration",
      isAgent: true,
      cause: opts.cause ?? `Deal #${dealId} committed`,
      refType: "delivery",
      refId: delivery.id,
    });
  } catch (err) {
    logger.error({ err, dealId }, "delivery timeline receipt failed");
  }

  try {
    const ids = await deliveryUserIds(deal.dealerId);
    await notifyUsers(ids, {
      dealerId: deal.dealerId,
      type: "system",
      title: `Delivery workflow started for ${deal.customerName}`,
      body: opts.cause ?? `Deal #${dealId} is ready for delivery preparation.`,
      link: "/deliveries",
    });
  } catch (err) {
    logger.error({ err, dealId }, "delivery start notification failed");
  }

  return delivery;
}
