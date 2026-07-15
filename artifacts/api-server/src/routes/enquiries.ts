import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  leadsTable,
  vehiclesTable,
  usersTable,
  rolesTable,
  timelineEventsTable,
} from "@workspace/db";
import { CreateEnquiryBody, CreateEnquiryResponse } from "@workspace/api-zod";
import { notifyUsers } from "../lib/email";
import { onLeadCreated } from "../lib/email-triggers";

const router: IRouter = Router();

// PUBLIC endpoint — mounted before requireAuth. Creates a lead from a
// website enquiry, fires the lead-received email and alerts coordinators.
router.post("/enquiries", async (req, res): Promise<void> => {
  const parsed = CreateEnquiryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const {
    name,
    email,
    phone,
    source,
    vehicleName,
    variant,
    color,
    preferredBranch,
    comments,
  } = parsed.data;

  // Try to match the free-text vehicle name to inventory.
  let interestedVehicleId: number | null = null;
  let matchedVehicleLabel: string | null = null;
  if (vehicleName && vehicleName.trim()) {
    const vehicles = await db.select().from(vehiclesTable);
    const needle = vehicleName.trim().toLowerCase();
    const match = vehicles.find((v) => {
      const full = `${v.year} ${v.make} ${v.model}`.toLowerCase();
      const short = `${v.make} ${v.model}`.toLowerCase();
      return (
        full.includes(needle) ||
        short.includes(needle) ||
        needle.includes(short)
      );
    });
    if (match) {
      interestedVehicleId = match.id;
      matchedVehicleLabel = `${match.year} ${match.make} ${match.model}`;
    }
  }

  const noteParts: string[] = [];
  if (comments && comments.trim()) noteParts.push(comments.trim());
  if (vehicleName && !matchedVehicleLabel)
    noteParts.push(`Enquired about: ${vehicleName}`);

  const [lead] = await db
    .insert(leadsTable)
    .values({
      name,
      email: email ?? null,
      phone: phone ?? null,
      channel: "web",
      source: source ?? "website",
      priority: "medium",
      phase: "aware",
      status: "new",
      interestedVehicleId,
      variant: variant ?? null,
      color: color ?? null,
      preferredBranch: preferredBranch ?? null,
      notes: noteParts.length ? noteParts.join("\n") : null,
    })
    .returning();

  await db.insert(timelineEventsTable).values({
    customerId: lead!.customerId,
    domain: "leads",
    kind: "enquiry_received",
    title: `Enquiry received from ${name}`,
    detail: matchedVehicleLabel
      ? `Website enquiry for the ${matchedVehicleLabel}${variant ? ` (${variant})` : ""}. Awaiting coordinator review.`
      : `Website enquiry captured. Awaiting coordinator review.`,
    actor: "Website",
    isAgent: true,
    refType: "lead",
    refId: lead!.id,
  });

  // Quote (when a vehicle was matched to inventory) or welcome email.
  if (lead) onLeadCreated(lead, vehicleName?.trim() || undefined);

  // Alert Marketing Coordinators (and managers) that a new enquiry landed.
  try {
    const coordinators = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
      .where(
        sql`${rolesTable.name} in ('Marketing Coordinator', 'Sales Manager', 'General Manager') and ${usersTable.status} = 'active'`,
      );
    await notifyUsers(
      coordinators.map((c) => c.id),
      {
        type: "assignment",
        title: `New enquiry: ${name}`,
        body: matchedVehicleLabel
          ? `Interested in the ${matchedVehicleLabel}. Review and assign an advisor.`
          : "New website enquiry awaiting review and advisor assignment.",
        link: "/pipeline",
      },
    );
  } catch (err) {
    req.log.error({ err }, "Failed to notify coordinators of enquiry");
  }

  res.status(201).json(CreateEnquiryResponse.parse(lead));
});

export default router;
