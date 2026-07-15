import { eq } from "drizzle-orm";
import {
  db,
  customersTable,
  vehiclesTable,
  type Lead,
  type Deal,
  type ServiceOrder,
} from "@workspace/db";
import { enqueueEmail, type TemplateData } from "./email";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Lifecycle email triggers — fire-and-forget, never fail the request
// ---------------------------------------------------------------------------

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

async function customerEmail(
  customerId: number | null | undefined,
): Promise<{ email: string | null; name: string | null }> {
  if (!customerId) return { email: null, name: null };
  const [c] = await db
    .select({ email: customersTable.email, name: customersTable.name })
    .from(customersTable)
    .where(eq(customersTable.id, customerId));
  return { email: c?.email ?? null, name: c?.name ?? null };
}

async function vehicleName(
  vehicleId: number | null | undefined,
): Promise<string | null> {
  if (!vehicleId) return null;
  const [v] = await db
    .select({
      year: vehiclesTable.year,
      make: vehiclesTable.make,
      model: vehiclesTable.model,
    })
    .from(vehiclesTable)
    .where(eq(vehiclesTable.id, vehicleId));
  return v ? `${v.year} ${v.make} ${v.model}` : null;
}

function fire(
  label: string,
  fn: () => Promise<void>,
): void {
  void fn().catch((err) => {
    logger.error({ err, trigger: label }, "lifecycle email trigger failed");
  });
}

async function send(opts: {
  template: Parameters<typeof enqueueEmail>[0]["template"];
  to: string | null | undefined;
  customerId?: number | null;
  data?: TemplateData;
}): Promise<void> {
  if (!opts.to) return;
  await enqueueEmail({
    template: opts.template,
    to: opts.to,
    customerId: opts.customerId ?? null,
    data: opts.data ?? {},
  });
}

async function leadRecipient(
  lead: Lead,
): Promise<{ to: string | null; name: string }> {
  if (lead.email) return { to: lead.email, name: lead.name };
  const c = await customerEmail(lead.customerId);
  return { to: c.email, name: c.name ?? lead.name };
}

const longDate = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

/**
 * New lead created → personalised PDF quote when a vehicle of interest is on
 * file (details pulled from inventory), otherwise the "lead_received" welcome.
 */
export function onLeadCreated(lead: Lead, fallbackVehicleName?: string): void {
  fire("lead_created", async () => {
    const { to, name } = await leadRecipient(lead);
    if (!to) return;

    const vehicleId = lead.interestedVehicleId;
    const [v] = vehicleId
      ? await db
          .select()
          .from(vehiclesTable)
          .where(eq(vehiclesTable.id, vehicleId))
      : [];

    if (!v) {
      await send({
        template: "lead_received",
        to,
        customerId: lead.customerId,
        data: {
          name,
          ...(fallbackVehicleName ? { vehicle: fallbackVehicleName } : {}),
        },
      });
      return;
    }

    const label = `${v.year} ${v.make} ${v.model}`;
    const version =
      v.trim || v.variant || lead.variant || "Standard specification";
    const color = v.exteriorColor || lead.color || "";
    const quantity = 1;
    const now = new Date();
    const validUntil = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    await send({
      template: "vehicle_quote",
      to,
      customerId: lead.customerId,
      data: {
        name,
        vehicle: label,
        model: v.model,
        version,
        color,
        quantity: String(quantity),
        unitPrice: money(v.price),
        total: money(v.price * quantity),
        quoteRef: `Q-${lead.id}-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`,
        issuedOn: longDate(now),
        validUntil: longDate(validUntil),
      },
    });
  });
}

/** Lead updated → advisor introduction / test-drive confirmation. */
export function onLeadUpdated(before: Lead, after: Lead): void {
  fire("lead_updated", async () => {
    const { to } = await leadRecipient(after);
    if (!to) return;
    const vehicle = await vehicleName(after.interestedVehicleId);

    if (after.assignedTo && after.assignedTo !== before.assignedTo) {
      await send({
        template: "lead_assignment",
        to,
        customerId: after.customerId,
        data: {
          advisor: after.assignedTo,
          ...(vehicle ? { vehicle } : {}),
        },
      });
    }
    // "engage" is the Appointment phase — confirm the test drive.
    if (after.phase === "engage" && before.phase !== "engage") {
      await send({
        template: "test_drive_confirmation",
        to,
        customerId: after.customerId,
        data: vehicle ? { vehicle } : {},
      });
    }
  });
}

async function dealRecipient(
  deal: Deal,
): Promise<{ to: string | null; name: string | null }> {
  const c = await customerEmail(deal.customerId);
  return { to: c.email, name: c.name ?? deal.customerName };
}

/** Deal stage transitions → finance / booking / delivery emails. */
export function onDealStageChanged(before: Deal, after: Deal): void {
  if (before.stage === after.stage) return;
  fire("deal_stage_changed", async () => {
    const { to, name } = await dealRecipient(after);
    if (!to) return;
    const vehicle = await vehicleName(after.vehicleId);
    const base: TemplateData = {
      ...(name ? { name } : {}),
      ...(vehicle ? { vehicle } : {}),
      amount: money(after.otdPrice || after.vehiclePrice),
    };

    switch (after.stage) {
      case "finance":
        await send({
          template: "finance_processing",
          to,
          customerId: after.customerId,
          data: base,
        });
        break;
      case "committed":
        await send({
          template: "finance_approved",
          to,
          customerId: after.customerId,
          data: base,
        });
        await send({
          template: "vehicle_booking",
          to,
          customerId: after.customerId,
          data: base,
        });
        break;
      case "delivered":
        await send({
          template: "delivery_confirmation",
          to,
          customerId: after.customerId,
          data: base,
        });
        break;
    }
  });
}

/** Finance application status transitions → processing / approved emails. */
export function onFinanceStatusChanged(
  app: {
    customerId: number | null;
    customerName: string;
    amount: number;
    apr: number;
    lender: string | null;
  },
  status: string,
): void {
  fire("finance_status_changed", async () => {
    const c = await customerEmail(app.customerId);
    if (!c.email) return;
    const base: TemplateData = {
      ...(c.name ? { name: c.name } : { name: app.customerName }),
      amount: money(app.amount),
      ...(app.lender ? { lender: app.lender } : {}),
      apr: `${app.apr}%`,
    };
    if (status === "submitted" || status === "under_review") {
      await send({
        template: "finance_processing",
        to: c.email,
        customerId: app.customerId,
        data: base,
      });
    } else if (status === "approved") {
      await send({
        template: "finance_approved",
        to: c.email,
        customerId: app.customerId,
        data: base,
      });
    }
  });
}

/** Service order completed → "vehicle_ready". */
export function onServiceOrderCompleted(
  before: ServiceOrder,
  after: ServiceOrder,
): void {
  if (after.status !== "completed" || before.status === "completed") return;
  fire("service_order_completed", async () => {
    const c = await customerEmail(after.customerId);
    if (!c.email) return;
    await send({
      template: "vehicle_ready",
      to: c.email,
      customerId: after.customerId,
      data: {
        ...(c.name ? { name: c.name } : {}),
        vehicle: after.vehicleInfo,
        service: after.type,
      },
    });
  });
}
