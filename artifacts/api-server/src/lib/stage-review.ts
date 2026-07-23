import { and, eq, ne, sql } from "drizzle-orm";
import {
  db,
  vehiclesTable,
  callLogsTable,
  contactsTable,
  type Lead,
} from "@workspace/db";

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
  leadDeals: { depositPaid: boolean | null }[],
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
    selected_model: () => Boolean(lead.selectedModel),
    reservation_fee: () => Boolean(lead.reservationFeePaid),
    primary_contact: async () => {
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
    // Vehicle Allocated (L5): a physical unit (VIN) must be bound to the
    // lead, and that unit must be clear of recall/damage flags.
    vin_allocated: async () => {
      if (!lead.interestedVehicleId) return false;
      const [v] = await db
        .select({ vin: vehiclesTable.vin })
        .from(vehiclesTable)
        .where(
          and(
            eq(vehiclesTable.id, lead.interestedVehicleId),
            eq(vehiclesTable.dealerId, dealerId),
          ),
        );
      return Boolean(v?.vin);
    },
    recall_clear: async () => {
      if (!lead.interestedVehicleId) return true;
      const [v] = await db
        .select({
          recallFlag: vehiclesTable.recallFlag,
          damageFlag: vehiclesTable.damageFlag,
        })
        .from(vehiclesTable)
        .where(
          and(
            eq(vehiclesTable.id, lead.interestedVehicleId),
            eq(vehiclesTable.dealerId, dealerId),
          ),
        );
      return !v || (!v.recallFlag && !v.damageFlag);
    },
    deposit_taken: () =>
      Boolean((deal && deal.depositPaid) || lead.reservationFeePaid),
    finance_approved: () =>
      Boolean(lead.financingQualified || lead.purchaseType === "cash"),
  };
}
