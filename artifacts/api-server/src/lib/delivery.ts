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
  rolesTable,
  rolePermissionsTable,
  customersTable,
  defaultDeliverySteps,
  DEFAULT_PDI_ITEMS,
  type Delivery,
} from "@workspace/db";
import { notifyUsers, notifyUser, enqueueEmail } from "./email";
import { logger } from "./logger";

/**
 * Timestamp-based round robin over the dealer's active Delivery Advisors:
 * whoever was assigned least recently (or never) is next. Reuses the
 * dealer_users.lastLeadAssignedAt rotation clock (same pattern as the
 * post-delivery Service Advisor rotation). Returns null when the dealer has
 * no active Delivery Advisors.
 */
async function pickDeliveryAdvisor(
  dealerId: number,
): Promise<{ id: number; name: string; neverAssigned: boolean } | null> {
  const rows = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      lastAssignedAt: dealerUsersTable.lastLeadAssignedAt,
    })
    .from(dealerUsersTable)
    .innerJoin(usersTable, eq(dealerUsersTable.userId, usersTable.id))
    .innerJoin(rolesTable, eq(dealerUsersTable.roleId, rolesTable.id))
    .where(
      and(
        eq(dealerUsersTable.dealerId, dealerId),
        eq(usersTable.status, "active"),
        eq(rolesTable.name, "Delivery Advisor"),
      ),
    );
  if (rows.length === 0) return null;
  const ranked = [...rows].sort((a, b) => {
    const at = a.lastAssignedAt?.getTime() ?? 0;
    const bt = b.lastAssignedAt?.getTime() ?? 0;
    return at !== bt ? at - bt : a.id - b.id;
  });
  const advisor = ranked[0]!;
  return {
    id: advisor.id,
    name: advisor.name ?? advisor.email ?? `User #${advisor.id}`,
    neverAssigned: advisor.lastAssignedAt == null,
  };
}

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
        // view is the explicit visibility switch — admin does not imply it
        eq(rolePermissionsTable.category, "view"),
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

  // Round-robin a Delivery Advisor when the caller didn't name one.
  let autoAdvisor: { id: number; name: string; neverAssigned: boolean } | null =
    null;
  if (opts.advisorUserId == null) {
    try {
      autoAdvisor = await pickDeliveryAdvisor(deal.dealerId);
    } catch (err) {
      logger.error({ err, dealId }, "delivery advisor round-robin failed");
    }
  }

  const [delivery] = await db
    .insert(deliveriesTable)
    .values({
      dealerId: deal.dealerId,
      dealId,
      bookingId: booking?.id ?? null,
      vehicleId: deal.vehicleId,
      customerId: deal.customerId ?? null,
      customerName: deal.customerName,
      advisorUserId: opts.advisorUserId ?? autoAdvisor?.id ?? null,
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

  // Advisor-assignment side effects: rotation stamp, timeline receipt,
  // advisor notification, and a customer introduction email.
  if (autoAdvisor) {
    try {
      await db
        .update(dealerUsersTable)
        .set({ lastLeadAssignedAt: new Date() })
        .where(
          and(
            eq(dealerUsersTable.dealerId, deal.dealerId),
            eq(dealerUsersTable.userId, autoAdvisor.id),
          ),
        );

      const reasoning = autoAdvisor.neverAssigned
        ? `Routed by round robin — ${autoAdvisor.name} had not been assigned yet.`
        : `Routed by round robin — ${autoAdvisor.name} had the longest wait on the delivery team.`;
      await db.insert(timelineEventsTable).values({
        dealerId: deal.dealerId,
        customerId: deal.customerId ?? null,
        domain: "delivery",
        kind: "advisor_assigned",
        title: `Delivery advisor: ${autoAdvisor.name}`,
        detail: reasoning,
        actor: "AURA System",
        isAgent: false,
        refType: "delivery",
        refId: delivery.id,
      });

      await notifyUser({
        userId: autoAdvisor.id,
        dealerId: deal.dealerId,
        type: "assignment",
        title: `Delivery assigned: ${deal.customerName}`,
        body: "AURA routed this delivery to you — coordinate preparation and the handover appointment.",
        link: "/deliveries",
      });
    } catch (err) {
      logger.error(
        { err, dealId, deliveryId: delivery.id },
        "delivery advisor assignment side effects failed",
      );
    }

    try {
      const customerEmail = deal.customerId
        ? (
            await db
              .select({ email: customersTable.email })
              .from(customersTable)
              .where(eq(customersTable.id, deal.customerId))
          )[0]?.email
        : null;
      if (customerEmail) {
        const vehicleLabel = deal.vehicleId
          ? await (async () => {
              const [v] = await db
                .select({
                  year: vehiclesTable.year,
                  make: vehiclesTable.make,
                  model: vehiclesTable.model,
                })
                .from(vehiclesTable)
                .where(eq(vehiclesTable.id, deal.vehicleId!));
              return v ? `${v.make} ${v.model}` : "";
            })()
          : "";
        await enqueueEmail({
          template: "delivery_advisor_assigned",
          to: customerEmail,
          dealerId: deal.dealerId,
          customerId: deal.customerId,
          data: {
            name: deal.customerName ?? "",
            advisor: autoAdvisor.name,
            ...(vehicleLabel ? { vehicle: vehicleLabel } : {}),
          },
        });
      }
    } catch (err) {
      logger.error(
        { err, dealId, deliveryId: delivery.id },
        "delivery advisor customer email failed",
      );
    }
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
