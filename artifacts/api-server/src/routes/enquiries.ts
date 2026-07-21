import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  leadsTable,
  vehiclesTable,
  timelineEventsTable,
} from "@workspace/db";
import {
  CreateEnquiryBody,
  CreateEnquiryResponse,
  ListEnquiryVehiclesResponse,
} from "@workspace/api-zod";
import { notifyUsers } from "../lib/email";
import { onLeadCreated } from "../lib/email-triggers";
import { autoAssignLead } from "../lib/lead-assignment";
import { findOpenDuplicate, mergeIntoExistingLead } from "../lib/lead-dedup";
import { defaultDealerId, dealerStaffIdsByRole } from "../lib/tenancy";

const router: IRouter = Router();

// PUBLIC endpoint — limited showroom fields for the enquiry form dropdown.
router.get("/enquiries/vehicles", async (_req, res): Promise<void> => {
  const vehicles = await db
    .select()
    .from(vehiclesTable)
    .where(eq(vehiclesTable.status, "available"));
  const items = vehicles
    .map((v) => ({
      id: v.id,
      year: v.year,
      make: v.make,
      model: v.model,
      name: `${v.year} ${v.make} ${v.model}`,
      version: v.trim || v.variant || "Standard specification",
      color: v.exteriorColor,
      vin: v.vin ?? null,
      price: v.price,
      imageUrl: v.imageUrl ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(ListEnquiryVehiclesResponse.parse(items));
});

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
    vehicleId,
    vehicleName,
    variant,
    color,
    preferredBranch,
    comments,
  } = parsed.data;

  // Public showroom is cross-dealer; the enquiry's dealer is derived from the
  // selected/matched vehicle. When no vehicle resolves, fall back to the
  // default dealer.
  let dealerId: number | null = null;

  // Preferred path: an explicit inventory selection from the dropdown.
  let interestedVehicleId: number | null = null;
  let matchedVehicleLabel: string | null = null;
  let matchedVariant: string | null = null;
  let matchedColor: string | null = null;
  if (vehicleId != null) {
    const [v] = await db
      .select()
      .from(vehiclesTable)
      .where(eq(vehiclesTable.id, vehicleId));
    if (!v) {
      res.status(422).json({ error: "Selected vehicle no longer exists" });
      return;
    }
    interestedVehicleId = v.id;
    dealerId = v.dealerId;
    matchedVehicleLabel = `${v.year} ${v.make} ${v.model}`;
    matchedVariant = v.trim || v.variant || null;
    matchedColor = v.exteriorColor || null;
  }
  // Legacy fallback: match a free-text vehicle name to inventory.
  if (interestedVehicleId === null && vehicleName && vehicleName.trim()) {
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
      dealerId = match.dealerId;
      matchedVehicleLabel = `${match.year} ${match.make} ${match.model}`;
    }
  }

  if (dealerId === null) dealerId = await defaultDealerId();

  const noteParts: string[] = [];
  if (comments && comments.trim()) noteParts.push(comments.trim());
  if (vehicleName && !matchedVehicleLabel)
    noteParts.push(`Enquired about: ${vehicleName}`);

  // Dedup agent: a matching open lead absorbs this enquiry instead of
  // creating a duplicate record.
  const duplicate = await findOpenDuplicate(dealerId, {
    name,
    email,
    phone,
    interestedVehicleId,
    variant: variant ?? matchedVariant,
    color: color ?? matchedColor,
    notes: noteParts.length ? noteParts.join("\n") : null,
  });
  if (duplicate) {
    const { lead: merged } = await mergeIntoExistingLead(
      duplicate,
      {
        name,
        email,
        phone,
        interestedVehicleId,
        variant: variant ?? matchedVariant,
        color: color ?? matchedColor,
        notes: noteParts.length ? noteParts.join("\n") : null,
      },
      "Website enquiry",
    );
    res.status(201).json(CreateEnquiryResponse.parse(merged));
    return;
  }

  const [lead] = await db
    .insert(leadsTable)
    .values({
      dealerId,
      name,
      email: email ?? null,
      phone: phone ?? null,
      channel: "web",
      source: source ?? "website",
      priority: "medium",
      phase: "aware",
      status: "new",
      interestedVehicleId,
      variant: variant ?? matchedVariant,
      color: color ?? matchedColor,
      preferredBranch: preferredBranch ?? null,
      notes: noteParts.length ? noteParts.join("\n") : null,
    })
    .returning();

  await db.insert(timelineEventsTable).values({
    dealerId: lead!.dealerId,
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

  // Sales agent routes the enquiry to the least-loaded advisor automatically.
  const assigned = lead ? await autoAssignLead(lead) : null;

  // Alert Marketing Coordinators (and managers) that a new enquiry landed.
  try {
    const coordinators = await dealerStaffIdsByRole(lead!.dealerId, [
      "Marketing Coordinator",
      "Sales Manager",
      "General Manager",
    ]);
    const routing = assigned?.assignedTo
      ? `AURA routed it to ${assigned.assignedTo}.`
      : "Awaiting advisor assignment.";
    await notifyUsers(
      coordinators,
      {
        dealerId: lead!.dealerId,
        type: "assignment",
        title: `New enquiry: ${name}`,
        body: matchedVehicleLabel
          ? `Interested in the ${matchedVehicleLabel}. ${routing}`
          : `New website enquiry captured. ${routing}`,
        link: "/pipeline",
      },
    );
  } catch (err) {
    req.log.error({ err }, "Failed to notify coordinators of enquiry");
  }

  res.status(201).json(CreateEnquiryResponse.parse(assigned ?? lead));
});

export default router;
