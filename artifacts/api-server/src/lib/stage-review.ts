import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  db,
  vehiclesTable,
  leadVehicleInterestsTable,
  deliveriesTable,
  dealItemsTable,
  callLogsTable,
  contactsTable,
  type Lead,
} from "@workspace/db";
import { ensureAccountForLead, ensurePrimaryContact } from "./accounts";

// ---------------------------------------------------------------------------
// Stage-advance review model — shared by the gated advance endpoint, the Run
// Review evaluation and the pipeline-progression agent so all three always
// agree on what "ready to advance" means.
// ---------------------------------------------------------------------------

export const ADVANCE_TARGET_PHASE = {
  qualified: "contacted",
  test_drive: "qualified",
  proposal: "proposal",
  negotiation: "negotiation",
  sold: "won",
} as const;
export type AdvanceStage = keyof typeof ADVANCE_TARGET_PHASE;

export const PHASE_ORDER = [
  "new",
  "contacted",
  "qualified",
  "proposal",
  "negotiation",
  "won",
];

export const REVIEW_STAGE_LABEL: Record<string, string> = {
  qualified: "Qualification",
  test_drive: "Test Drive",
  proposal: "Proposal",
  negotiation: "Negotiation",
  sold: "Booking Confirmed",
};

export const ADVANCE_STAGE_LABEL: Record<string, string> = {
  qualified: "Qualified",
  test_drive: "Test Drive",
  proposal: "Proposal",
  negotiation: "Negotiation",
  sold: "Sold",
};

// Who is accountable for clearing each checklist item — shown as owner chips
// in the Run Review stepper.
export const CHECK_OWNER: Record<string, string> = {
  call_logged: "Sales Advisor",
  contact_details: "Sales Advisor",
  vehicle_selected: "Sales Advisor",
  budget_discussed: "Sales Advisor",
  test_drive_booked: "Sales Advisor",
  licence_on_file: "Customer",
  waiver_signed: "Customer",
  vehicle_available: "Inventory",
  test_drive_completed: "Sales Advisor",
  quote_sent: "Sales Advisor",
  deal_created: "Sales Manager",
  deal_exists: "Sales Manager",
  selected_model: "Sales Advisor",
  reservation_fee: "Sales Advisor",
  primary_contact: "Sales Advisor",
  vin_allocated: "Sales Advisor",
  recall_clear: "Inventory",
  deposit_taken: "Finance",
  finance_approved: "Finance",
};

/** The next stage this lead could advance to, or null when at the end. */
export function nextAdvanceStage(lead: Lead): AdvanceStage | null {
  const fromIdx = PHASE_ORDER.indexOf(lead.phase);
  for (const stage of Object.keys(ADVANCE_TARGET_PHASE) as AdvanceStage[]) {
    if (PHASE_ORDER.indexOf(ADVANCE_TARGET_PHASE[stage]) === fromIdx + 1)
      return stage;
  }
  return null;
}

// Built-in check implementations, keyed by checklist item key.
export function buildStageChecks(
  lead: Lead,
  dealerId: number,
  leadDeals: { id: number; stage: string; depositPaid: boolean | null }[],
  // selfHeal: only the gated stage-advance WRITE path may let checks repair
  // data (auto-link account / backfill primary contact). Read paths (review
  // stepper, agent briefs, proposals) must stay side-effect free.
  opts: { selfHeal?: boolean } = {},
): Record<string, () => Promise<boolean> | boolean> {
  const deal = leadDeals[0];
  return {
    // Layer 2 Contacted gate: at least one call logged with a real outcome
    // (any disposition except a still-in-progress browser call).
    call_logged: async () => {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(callLogsTable)
        .where(
          and(
            eq(callLogsTable.leadId, lead.id),
            eq(callLogsTable.dealerId, dealerId),
            ne(callLogsTable.status, "in_progress"),
          ),
        );
      return (row?.n ?? 0) > 0;
    },
    contact_details: () => Boolean(lead.email || lead.phone),
    // Capture is model-only per the DMS spec (unit/VIN binds at Vehicle
    // Allocated), so a recorded model of interest also satisfies this check.
    vehicle_selected: () =>
      Boolean(lead.interestedVehicleId || lead.selectedModel),
    budget_discussed: () => Boolean(lead.budgetFinancing),
    test_drive_booked: () => Boolean(lead.testDriveAt),
    licence_on_file: () => Boolean(lead.testDriveLicence),
    waiver_signed: () => Boolean(lead.testDriveWaiver),
    vehicle_available: async () => {
      if (!lead.interestedVehicleId) return true;
      const [v] = await db
        .select({ status: vehiclesTable.status })
        .from(vehiclesTable)
        .where(
          and(
            eq(vehiclesTable.id, lead.interestedVehicleId),
            eq(vehiclesTable.dealerId, dealerId),
          ),
        );
      return !v || v.status === "available" || v.status === "reserved";
    },
    test_drive_completed: () => Boolean(lead.testDriveAt),
    quote_sent: () => Boolean(lead.quotationSent),
    deal_created: () => leadDeals.length > 0,
    deal_exists: () => Boolean(deal),
    // Pre-Book (L4) gates: model locked, fee paid (or manager-approved
    // waiver — the waiver flips reservationFeePaid too), account linked
    // with a primary contact on file.
    selected_model: async () => {
      if (lead.selectedModel || lead.interestedVehicleId) return true;
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(leadVehicleInterestsTable)
        .where(and(
          eq(leadVehicleInterestsTable.dealerId, dealerId),
          eq(leadVehicleInterestsTable.leadId, lead.id),
        ));
      return (row?.n ?? 0) > 0;
    },
    reservation_fee: () => Boolean(lead.reservationFeePaid),
    primary_contact: async () => {
      // Self-healing (write path only): linking an account with a primary
      // contact is AURA's job, not a manual step. If the lead has no account
      // yet, promote it now; if the linked account lacks a primary contact,
      // backfill one from the lead's details (both helpers never throw).
      if (opts.selfHeal) {
        if (!lead.customerId) {
          lead.customerId = await ensureAccountForLead(lead, "reservation");
        }
        if (lead.customerId) {
          // ensureAccountForLead guarantees a primary contact on creation,
          // but a matched pre-existing account may still lack one.
          await ensurePrimaryContact(dealerId, lead.customerId, {
            name: lead.name,
            email: lead.email,
            phone: lead.phone,
            title: lead.title ?? null,
          });
        }
      }
      if (!lead.customerId) return false;
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(contactsTable)
        .where(
          and(
            eq(contactsTable.accountId, lead.customerId),
            eq(contactsTable.dealerId, dealerId),
            eq(contactsTable.isPrimary, true),
          ),
        );
      return (row?.n ?? 0) > 0;
    },
    // Vehicle Allocated (L5): every physical unit committed by every deal
    // item must have one distinct delivery/VIN. Leads and specification
    // interests never own or reserve a physical vehicle directly.
    vin_allocated: async () => {
      const dealIds = leadDeals
        .filter((candidate) =>
          candidate.stage === "committed" || candidate.stage === "delivered"
        )
        .map((candidate) => candidate.id);
      if (!dealIds.length) return false;
      const items = await db
        .select({
          id: dealItemsTable.id,
          quantity: dealItemsTable.quantity,
        })
        .from(dealItemsTable)
        .where(and(
          eq(dealItemsTable.dealerId, dealerId),
          inArray(dealItemsTable.dealId, dealIds),
        ));
      if (!items.length) return false;
      const allocated = await db
        .select({
          dealItemId: deliveriesTable.dealItemId,
          unit: deliveriesTable.dealItemUnit,
          vehicleId: deliveriesTable.vehicleId,
        })
        .from(deliveriesTable)
        .innerJoin(
          vehiclesTable,
          and(
            eq(vehiclesTable.id, deliveriesTable.vehicleId),
            eq(vehiclesTable.dealerId, dealerId),
          ),
        )
        .where(and(
          eq(deliveriesTable.dealerId, dealerId),
          inArray(deliveriesTable.dealId, dealIds),
          sql`length(${vehiclesTable.vin}) = 17`,
        ));
      const expectedCount = items.reduce(
        (sum, item) => sum + item.quantity,
        0,
      );
      if (allocated.length !== expectedCount) return false;
      if (
        new Set(allocated.map((delivery) => delivery.vehicleId)).size !==
        allocated.length
      ) {
        return false;
      }
      return items.every((item) => {
        const units = allocated
          .filter((delivery) => delivery.dealItemId === item.id)
          .map((delivery) => delivery.unit)
          .sort((a, b) => (a ?? -1) - (b ?? -1));
        return units.length === item.quantity &&
          units.every((unit, index) => unit === index);
      });
    },
    recall_clear: async () => {
      const dealIds = leadDeals
        .filter((candidate) =>
          candidate.stage === "committed" || candidate.stage === "delivered"
        )
        .map((candidate) => candidate.id);
      if (!dealIds.length) return true;
      const allocated = await db
        .select({
          recallFlag: vehiclesTable.recallFlag,
          damageFlag: vehiclesTable.damageFlag,
        })
        .from(deliveriesTable)
        .innerJoin(
          vehiclesTable,
          and(
            eq(vehiclesTable.id, deliveriesTable.vehicleId),
            eq(vehiclesTable.dealerId, dealerId),
          ),
        )
        .where(and(
          eq(deliveriesTable.dealerId, dealerId),
          inArray(deliveriesTable.dealId, dealIds),
        ));
      return allocated.every((unit) => !unit.recallFlag && !unit.damageFlag);
    },
    deposit_taken: () =>
      Boolean((deal && deal.depositPaid) || lead.reservationFeePaid),
    finance_approved: () =>
      Boolean(lead.financingQualified || lead.purchaseType === "cash"),
  };
}
