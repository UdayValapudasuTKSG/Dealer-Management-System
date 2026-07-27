import { and, eq, ne } from "drizzle-orm";
import {
  db,
  customersTable,
  dealsTable,
  leadsTable,
  testDrivesTable,
  timelineEventsTable,
  vehiclesTable,
  agentRunsTable,
  type CallLog,
  type Lead,
  type ChecklistStage,
} from "@workspace/db";
import {
  MIN_AGENT_CONFIDENCE,
  recordAgentRun,
} from "./agent-governance";
import { enqueueEmail, enqueueWhatsapp, notifyUser } from "./email";
import { testDriveBookingUrl } from "./email-triggers";
import { ownerCalendarContact, testDriveCalendarFields } from "./calendar";
import {
  afterTestDriveBooked,
  vehicleAvailabilityError,
} from "./test-drive-scheduler";
import { getActiveChecklist } from "./stage-checklists";
import { buildStageChecks, nextAdvanceStage, ADVANCE_TARGET_PHASE, ADVANCE_STAGE_LABEL } from "./stage-review";
import { ensureAccountForLead } from "./accounts";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Test-drive intent agent — after a call transcript is analyzed, the same
// model pass extracts test-drive intent. This module turns that extraction
// into action with deterministic guardrails:
//   • clear future time inside showroom hours → auto-book the drive,
//     confirm by email (.ics calendar invite) + WhatsApp, then attempt a
//     checklist-gated stage advance (same rules as POST /leads/{id}/advance).
//   • intent but no clear/plausible time, low confidence, vehicle
//     unavailable, or slot conflict → send the tokenized self-service
//     booking link instead and flag the advisor ("time needed").
//   • already-booked upcoming drive + a NEW clear, confident, plausible time
//     → auto-RESCHEDULE the existing drive (update the booking, re-confirm
//     by email/WhatsApp with the new time, alert the advisor).
//   • already-booked upcoming drive with no clear new time → never
//     duplicate; reference the existing booking and offer the reschedule link.
// Idempotent per call (agent_runs is the ledger), kill-switch aware (the
// caller checks isAgentEnabled before analysis runs at all), and every
// outcome lands on the lead timeline + agent governance.
// ---------------------------------------------------------------------------

const AGENT_KEY = "test_drive_availability";
const AGENT_ACTOR = "AURA Sales Agent";
const RUN_TYPE = "test_drive_intent_auto";
const OPEN_HOUR = 9; // aligned with the self-service booking window
const LAST_HOUR = 16;
const MAX_DAYS_AHEAD = 30;

export type TestDriveIntentExtraction = {
  /** Did the customer express interest in a test drive on this call? */
  intent: boolean;
  /** "YYYY-MM-DDTHH:mm" in Guyana time (GMT-4) — only when explicitly stated. */
  timeText: string | null;
  /** Model confidence (0–1) that the extracted time is what the customer meant. */
  timeConfidence: number | null;
  /** Vehicle the customer mentioned, if any (informational only). */
  vehicleMention: string | null;
};

const GUYANA_OFFSET = "-04:00";

/** Deterministic guardrail: parse the extracted Guyana-local time. Returns a
 * UTC Date only when the time is plausible (future, showroom hours, near-term). */
function plausibleDriveTime(timeText: string | null): Date | null {
  if (!timeText) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(timeText.trim());
  if (!m) return null;
  const hour = Number(m[4]);
  if (hour < OPEN_HOUR || hour > LAST_HOUR) return null; // outside showroom hours
  const when = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00${GUYANA_OFFSET}`);
  if (Number.isNaN(when.getTime())) return null;
  const now = Date.now();
  if (when.getTime() < now + 30 * 60_000) return null; // past / too soon
  if (when.getTime() > now + MAX_DAYS_AHEAD * 24 * 60 * 60_000) return null;
  return when;
}

/** Google Maps directions link for the showroom branch. */
export function showroomMapsUrl(branch: string | null | undefined): string {
  const query = `AURA Dealership ${branch ?? "Main Showroom"}, Georgetown, Guyana`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

const guyanaLabel = (d: Date) =>
  d.toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Guyana",
  });

async function alreadyProcessed(call: CallLog): Promise<boolean> {
  const [run] = await db
    .select({ id: agentRunsTable.id })
    .from(agentRunsTable)
    .where(
      and(
        eq(agentRunsTable.dealerId, call.dealerId),
        eq(agentRunsTable.agentKey, AGENT_KEY),
        eq(agentRunsTable.runType, RUN_TYPE),
        eq(agentRunsTable.refType, "call_log"),
        eq(agentRunsTable.refId, call.id),
        ne(agentRunsTable.status, "error"),
      ),
    )
    .limit(1);
  return Boolean(run);
}

async function logTimeline(
  lead: Lead | null,
  call: CallLog,
  kind: string,
  title: string,
  detail: string,
): Promise<void> {
  await db.insert(timelineEventsTable).values({
    dealerId: call.dealerId,
    customerId: lead?.customerId ?? null,
    domain: "leads",
    kind,
    title,
    detail,
    actor: AGENT_ACTOR,
    isAgent: true,
    refType: lead ? "lead" : "call_log",
    refId: lead ? lead.id : call.id,
  });
}

async function leadEmailAddress(lead: Lead): Promise<string | null> {
  if (lead.email) return lead.email;
  if (!lead.customerId) return null;
  const [c] = await db
    .select({ email: customersTable.email })
    .from(customersTable)
    .where(
      and(
        eq(customersTable.id, lead.customerId),
        eq(customersTable.dealerId, lead.dealerId),
      ),
    );
  return c?.email ?? null;
}

async function vehicleLabelFor(lead: Lead): Promise<string | null> {
  if (!lead.interestedVehicleId) return null;
  const [v] = await db
    .select({
      year: vehiclesTable.year,
      make: vehiclesTable.make,
      model: vehiclesTable.model,
    })
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.id, lead.interestedVehicleId),
        eq(vehiclesTable.dealerId, lead.dealerId),
      ),
    );
  return v ? `${v.year} ${v.make} ${v.model}` : null;
}

/** Channels the customer actually has; used to report skipped ones. */
function channelReport(email: string | null, phone: string | null): string {
  const skipped: string[] = [];
  if (!email) skipped.push("email (none on file)");
  if (!phone) skipped.push("WhatsApp (no phone on file)");
  return skipped.length > 0 ? ` Skipped channels: ${skipped.join(", ")}.` : "";
}

/** Send the self-service time-selection link on every channel the lead has. */
async function sendSelectionLink(
  lead: Lead,
  call: CallLog,
  vehicle: string | null,
  reason: string,
  opts?: { reschedule?: boolean },
): Promise<string> {
  const link = testDriveBookingUrl(lead.testDriveToken);
  const email = await leadEmailAddress(lead);
  const phone = (lead.phone ?? "").replace(/\D/g, "") || null;
  const firstName = lead.name.split(/\s+/)[0];

  if (email && link) {
    await enqueueEmail({
      dealerId: lead.dealerId,
      template: "test_drive_invite",
      to: email,
      customerId: lead.customerId,
      leadId: lead.id,
      data: {
        name: lead.name,
        link,
        ...(vehicle ? { vehicle } : {}),
      },
      dedupeKey: `tdintent:${call.id}:link-email`,
    });
  }
  if (phone && link) {
    const body = opts?.reschedule
      ? `Hi ${firstName}! Thanks for your call — you already have a test drive booked with us. If you'd like a different time, pick one here (takes under a minute): ${link}`
      : `Hi ${firstName}! Thanks for your call — we'd love to get you behind the wheel${vehicle ? ` of the ${vehicle}` : ""}. Pick a time that suits you here (takes under a minute): ${link}`;
    await enqueueWhatsapp({
      kind: "whatsapp_message",
      to: phone,
      body,
      dealerId: lead.dealerId,
      leadId: lead.id,
      customerId: lead.customerId,
      actor: AGENT_ACTOR,
      summary: `Test-drive time-selection link — ${lead.name}`,
      dedupeKey: `tdintent:${call.id}:link-wa`,
    });
  }

  // Advisor follow-up: a human should chase the time if the link is ignored.
  if (lead.ownerUserId && !opts?.reschedule) {
    await notifyUser({
      userId: lead.ownerUserId,
      dealerId: lead.dealerId,
      type: "task",
      title: `Test-drive time needed: ${lead.name}`,
      body: `${reason} A self-service booking link was sent — follow up if no slot is picked.`,
      link: `/lead/${lead.id}`,
    });
  }
  return channelReport(email, phone);
}

/** Checklist-gated stage advance, identical rules to POST /leads/{id}/advance. */
async function attemptAutoAdvance(
  leadId: number,
  dealerId: number,
): Promise<{ advanced: string | null; unmet: string[] }> {
  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.dealerId, dealerId)));
  if (!lead) return { advanced: null, unmet: ["Lead not found"] };
  const stage = nextAdvanceStage(lead);
  if (!stage) return { advanced: null, unmet: ["No next stage"] };

  const deals = await db
    .select({ depositPaid: dealsTable.depositPaid })
    .from(dealsTable)
    .where(and(eq(dealsTable.dealerId, dealerId), eq(dealsTable.leadId, lead.id)));

  const checklist = await getActiveChecklist(dealerId, stage as ChecklistStage);
  const checks = buildStageChecks(lead, dealerId, deals);
  const unmet: string[] = [];
  for (const item of checklist.items) {
    if (!item.enabled) continue;
    const check = checks[item.key];
    if (!check) continue;
    if (!(await check())) unmet.push(item.label);
  }
  if (unmet.length > 0) return { advanced: null, unmet };

  await db
    .update(leadsTable)
    .set({
      phase: ADVANCE_TARGET_PHASE[stage],
      stageEnteredAt: new Date(),
      ...(stage === "sold" ? { status: "converted" as const } : {}),
    })
    .where(and(eq(leadsTable.id, lead.id), eq(leadsTable.dealerId, dealerId)));
  return { advanced: ADVANCE_STAGE_LABEL[stage] ?? stage, unmet: [] };
}

type RunBase = {
  dealerId: number;
  agentKey: string;
  runType: string;
  inputSource: string;
  inputSummary: string;
  refType: "call_log";
  refId: number;
};

/** Auto-reschedule an existing upcoming drive to the newly stated time. */
async function rescheduleDrive(
  lead: Lead,
  call: CallLog,
  vehicle: string | null,
  when: Date,
  previousAt: Date,
  runBase: RunBase,
  started: number,
): Promise<void> {
  const [updated] = await db
    .update(leadsTable)
    .set({ testDriveAt: when })
    .where(
      and(eq(leadsTable.id, lead.id), eq(leadsTable.dealerId, lead.dealerId)),
    )
    .returning();
  if (!updated) return;

  // First-class record: supersede the scheduled drive, insert the new slot.
  await db
    .update(testDrivesTable)
    .set({ status: "cancelled", cancelledAt: new Date() })
    .where(
      and(
        eq(testDrivesTable.dealerId, updated.dealerId),
        eq(testDrivesTable.leadId, updated.id),
        eq(testDrivesTable.status, "scheduled"),
      ),
    );
  const [drive] = await db
    .insert(testDrivesTable)
    .values({
      dealerId: updated.dealerId,
      leadId: updated.id,
      vehicleId: updated.interestedVehicleId ?? null,
      customerId: updated.customerId ?? null,
      status: "scheduled",
      scheduledAt: when,
      branch: updated.testDriveBranch,
      licenceNumber: updated.testDriveLicence,
      waiverAccepted: updated.testDriveWaiver ?? false,
      bookedVia: "agent",
    })
    .returning();

  const prevLabel = guyanaLabel(previousAt);
  const whenLabel = guyanaLabel(when);
  const dateStr = when.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/Guyana",
  });
  const timeStr = when.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Guyana",
  });
  const mapsLink = showroomMapsUrl(updated.testDriveBranch);

  // Updated confirmation with a fresh .ics (calendars replace the event).
  const email = await leadEmailAddress(updated);
  const phone = (updated.phone ?? "").replace(/\D/g, "") || null;
  const owner = await ownerCalendarContact(updated.ownerUserId);
  const calendarFields = testDriveCalendarFields(updated, vehicle, owner);
  if (email) {
    await enqueueEmail({
      dealerId: updated.dealerId,
      template: "test_drive_confirmation",
      to: email,
      customerId: updated.customerId,
      leadId: updated.id,
      data: {
        vehicle: vehicle ?? "",
        date: dateStr,
        time: timeStr,
        rescheduled: "true",
        previousLabel: prevLabel,
        mapsLink,
        ...calendarFields,
      },
      dedupeKey: `tdintent:${call.id}:resched-email`,
    });
  }
  if (phone) {
    await enqueueWhatsapp({
      kind: "whatsapp_message",
      to: phone,
      body:
        `Hi ${updated.name.split(/\s+/)[0]}! As discussed on the call, your test drive` +
        `${vehicle ? ` of the ${vehicle}` : ""} has been moved to ${whenLabel} (Guyana time), ` +
        `previously ${prevLabel}. An updated calendar invite is on its way to your email. ` +
        `Directions to the showroom: ${mapsLink}`,
      dealerId: updated.dealerId,
      leadId: updated.id,
      customerId: updated.customerId,
      actor: AGENT_ACTOR,
      summary: `Test drive auto-rescheduled — ${updated.name}, ${whenLabel}`,
      dedupeKey: `tdintent:${call.id}:resched-wa`,
    });
  }
  const skipped = channelReport(email, phone);

  // Advisor heads-up about the change.
  if (updated.ownerUserId) {
    await notifyUser({
      userId: updated.ownerUserId,
      dealerId: updated.dealerId,
      type: "task",
      title: `Test drive rescheduled: ${updated.name} — now ${dateStr}`,
      body: `Moved from ${prevLabel} to ${timeStr} by AURA from the call transcript. Customer was notified by email/WhatsApp.`,
      link: `/lead/${updated.id}`,
    });
  }

  // Re-lock the unit + move the 24h reminder to the new slot.
  await afterTestDriveBooked(updated, when, vehicle);

  await logTimeline(
    updated,
    call,
    "test_drive_scheduled",
    `Test drive rescheduled to ${dateStr}`,
    `AURA detected a reschedule request on call #${call.id} and moved the test drive from ${prevLabel} to ${whenLabel} (Guyana time). Updated confirmation sent${email ? " by email (with calendar invite)" : ""}${email && phone ? " and" : ""}${phone ? " by WhatsApp" : ""}, and the advisor was notified.${skipped}`,
  );

  await recordAgentRun({
    ...runBase,
    outputSummary: `Auto-rescheduled test drive #${drive?.id ?? "?"} from ${prevLabel} to ${whenLabel} from the call transcript`,
    confidence: null,
    latencyMs: Date.now() - started,
    mutation: true,
    changeSummary: `Call #${call.id} → test drive moved ${prevLabel} → ${whenLabel}; customer + advisor notified`,
    affectedEntities: [
      { type: "test_drive", id: drive?.id ?? 0 },
      { type: "lead", id: updated.id },
      { type: "call_log", id: call.id },
    ],
  });
}

/**
 * Act on the extracted test-drive intent for an analyzed call.
 * The caller has already verified the agent kill switch. Never throws.
 */
export async function handleTestDriveIntent(
  call: CallLog,
  lead: Lead | null,
  extraction: TestDriveIntentExtraction,
): Promise<void> {
  try {
    if (await alreadyProcessed(call)) return; // duplicate transcription/webhook retry
    const started = Date.now();
    const runBase = {
      dealerId: call.dealerId,
      agentKey: AGENT_KEY,
      runType: RUN_TYPE,
      inputSource: "calls",
      inputSummary: `Call #${call.id} transcript`,
      refType: "call_log" as const,
      refId: call.id,
    };

    // ---- No intent -------------------------------------------------------
    if (!extraction.intent) {
      await recordAgentRun({
        ...runBase,
        outputSummary: "No test-drive intent detected in the transcript",
        confidence: 1,
        latencyMs: Date.now() - started,
      });
      await logTimeline(
        lead,
        call,
        "call_intent",
        "No test-drive intent on call",
        `Call #${call.id} transcript was screened — the customer did not ask about a test drive.`,
      );
      return;
    }

    // ---- Intent, but the call isn't linked to a lead ----------------------
    if (!lead) {
      await recordAgentRun({
        ...runBase,
        outputSummary:
          "Test-drive intent detected but the call is not linked to a lead — no booking made",
        confidence: extraction.timeConfidence,
        latencyMs: Date.now() - started,
      });
      await logTimeline(
        null,
        call,
        "call_intent",
        "Test-drive intent detected (no lead)",
        `Call #${call.id} mentioned a test drive but is not linked to a lead, so no booking was made.`,
      );
      return;
    }

    const vehicle = await vehicleLabelFor(lead);

    // ---- Deterministic time guardrails -------------------------------------
    const confident =
      extraction.timeConfidence != null &&
      extraction.timeConfidence >= MIN_AGENT_CONFIDENCE;
    const when = confident ? plausibleDriveTime(extraction.timeText) : null;

    // Vehicle must be drivable; a held/sold unit falls back to the link path.
    const vehicleProblem = await vehicleAvailabilityError(lead);

    // Slot conflict with another lead's drive (one drive at a time).
    let slotTaken = false;
    if (when) {
      const [conflict] = await db
        .select({ id: leadsTable.id })
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.dealerId, lead.dealerId),
            eq(leadsTable.testDriveAt, when),
            ne(leadsTable.id, lead.id),
          ),
        );
      slotTaken = Boolean(conflict);
    }

    // ---- Already has an upcoming drive -------------------------------------
    const hasUpcoming =
      lead.testDriveAt != null && lead.testDriveAt.getTime() > Date.now();
    if (hasUpcoming) {
      const existingAt = lead.testDriveAt!;
      const existingLabel = guyanaLabel(existingAt);
      const sameTime =
        when != null && Math.abs(when.getTime() - existingAt.getTime()) < 60_000;

      // New clear, confident, plausible time → auto-RESCHEDULE the drive.
      if (when && !sameTime && !slotTaken && !vehicleProblem) {
        await rescheduleDrive(lead, call, vehicle, when, existingAt, runBase, started);
        return;
      }

      // Customer just confirmed the existing slot, or no usable new time →
      // never duplicate; offer the self-service reschedule link instead.
      const summary = sameTime
        ? `Customer re-confirmed the existing test drive for ${existingLabel} — no change needed`
        : `Intent detected but a test drive is already booked for ${existingLabel} — reschedule link offered instead`;
      const skipped = sameTime
        ? ""
        : await sendSelectionLink(lead, call, vehicle, "", { reschedule: true });
      await recordAgentRun({
        ...runBase,
        outputSummary: summary,
        confidence: extraction.timeConfidence,
        latencyMs: Date.now() - started,
      });
      await logTimeline(
        lead,
        call,
        "call_intent",
        sameTime
          ? "Test drive re-confirmed on call"
          : "Test-drive intent on call — booking already exists",
        sameTime
          ? `The customer confirmed the upcoming test drive for ${existingLabel} on call #${call.id}. No changes were made.`
          : `The customer mentioned a test drive on call #${call.id}. An upcoming drive is already booked for ${existingLabel}; a reschedule link was sent instead of a duplicate booking.${skipped}`,
      );
      return;
    }

    if (!when || vehicleProblem || slotTaken) {
      const reason = vehicleProblem
        ? vehicleProblem
        : slotTaken
          ? "The mentioned time is already taken by another booking."
          : !confident && extraction.timeText
            ? "The mentioned time could not be confirmed with confidence."
            : extraction.timeText
              ? "The mentioned time is in the past or outside showroom hours."
              : "No clear date/time was stated on the call.";
      const skipped = await sendSelectionLink(lead, call, vehicle, reason);
      await recordAgentRun({
        ...runBase,
        outputSummary: `Test-drive intent detected; ${reason} Self-service booking link sent.`,
        confidence: extraction.timeConfidence,
        latencyMs: Date.now() - started,
        affectedEntities: [
          { type: "lead", id: lead.id },
          { type: "call_log", id: call.id },
        ],
      });
      await logTimeline(
        lead,
        call,
        "call_intent",
        "Test-drive intent on call — time needed",
        `The customer asked about a test drive on call #${call.id}. ${reason} A self-service time-selection link was sent and the advisor was flagged to follow up.${skipped}`,
      );
      return;
    }

    // ---- Auto-book ---------------------------------------------------------
    const [updated] = await db
      .update(leadsTable)
      .set({
        testDriveAt: when,
        testDriveBranch:
          lead.testDriveBranch ?? lead.preferredBranch ?? "Main Showroom",
        status: "test_drive",
      })
      .where(
        and(eq(leadsTable.id, lead.id), eq(leadsTable.dealerId, lead.dealerId)),
      )
      .returning();
    if (!updated) return;
    updated.customerId = await ensureAccountForLead(updated);

    // First-class record: supersede any stale scheduled drive, insert the new one.
    await db
      .update(testDrivesTable)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(
        and(
          eq(testDrivesTable.dealerId, updated.dealerId),
          eq(testDrivesTable.leadId, updated.id),
          eq(testDrivesTable.status, "scheduled"),
        ),
      );
    const [drive] = await db
      .insert(testDrivesTable)
      .values({
        dealerId: updated.dealerId,
        leadId: updated.id,
        vehicleId: updated.interestedVehicleId ?? null,
        customerId: updated.customerId ?? null,
        status: "scheduled",
        scheduledAt: when,
        branch: updated.testDriveBranch,
        licenceNumber: updated.testDriveLicence,
        waiverAccepted: updated.testDriveWaiver ?? false,
        bookedVia: "agent",
      })
      .returning();

    const whenLabel = guyanaLabel(when);
    const dateStr = when.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: "America/Guyana",
    });
    const timeStr = when.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Guyana",
    });

    // Confirmation email with the .ics calendar invite.
    const email = await leadEmailAddress(updated);
    const phone = (updated.phone ?? "").replace(/\D/g, "") || null;
    const owner = await ownerCalendarContact(updated.ownerUserId);
    const calendarFields = testDriveCalendarFields(updated, vehicle, owner);
    if (email) {
      await enqueueEmail({
        dealerId: updated.dealerId,
        template: "test_drive_confirmation",
        to: email,
        customerId: updated.customerId,
        leadId: updated.id,
        data: {
          vehicle: vehicle ?? "",
          date: dateStr,
          time: timeStr,
          mapsLink: showroomMapsUrl(updated.testDriveBranch),
          ...calendarFields,
        },
        dedupeKey: `tdintent:${call.id}:confirm-email`,
      });
    }
    if (phone) {
      const link = testDriveBookingUrl(updated.testDriveToken);
      await enqueueWhatsapp({
        kind: "whatsapp_message",
        to: phone,
        body:
          `Hi ${updated.name.split(/\s+/)[0]}! Following up on your call — your test drive` +
          `${vehicle ? ` of the ${vehicle}` : ""} is booked for ${whenLabel} (Guyana time). ` +
          `A calendar invite is on its way to your email. ` +
          `Directions to the showroom: ${showroomMapsUrl(updated.testDriveBranch)}` +
          `${link ? ` Need a different time? Pick one here: ${link}` : ""}`,
        dealerId: updated.dealerId,
        leadId: updated.id,
        customerId: updated.customerId,
        actor: AGENT_ACTOR,
        summary: `Auto-booked test drive confirmation — ${updated.name}, ${whenLabel}`,
        dedupeKey: `tdintent:${call.id}:confirm-wa`,
      });
    }
    const skipped = channelReport(email, phone);

    // Advisor heads-up.
    if (updated.ownerUserId) {
      await notifyUser({
        userId: updated.ownerUserId,
        dealerId: updated.dealerId,
        type: "task",
        title: `Test drive auto-booked: ${updated.name} — ${dateStr}`,
        body: `${vehicle ?? "Vehicle"} at ${timeStr}, booked by AURA from the call transcript. Have the car ready.`,
        link: `/lead/${updated.id}`,
      });
    }

    // Soft-lock single-unit models + queue the 24h WhatsApp reminder.
    await afterTestDriveBooked(updated, when, vehicle);

    // Checklist-gated auto-advance — same rules as the manual advance flow.
    const advance = await attemptAutoAdvance(updated.id, updated.dealerId);

    await logTimeline(
      updated,
      call,
      "test_drive_scheduled",
      `Test drive auto-booked for ${dateStr}`,
      `AURA detected test-drive intent on call #${call.id} and booked ${vehicle ?? "the vehicle"} for ${whenLabel} (Guyana time). Confirmation sent${email ? " by email (with calendar invite)" : ""}${email && phone ? " and" : ""}${phone ? " by WhatsApp" : ""}.${skipped}${
        advance.advanced
          ? ` Stage auto-advanced to ${advance.advanced} — all checklist criteria met.`
          : advance.unmet.length > 0 && advance.unmet[0] !== "No next stage"
            ? ` Stage not advanced — outstanding: ${advance.unmet.join(", ")}.`
            : ""
      }`,
    );

    await recordAgentRun({
      ...runBase,
      outputSummary: `Auto-booked test drive #${drive?.id ?? "?"} for ${whenLabel} from the call transcript${
        advance.advanced ? `; stage advanced to ${advance.advanced}` : advance.unmet.length > 0 ? `; stage held (${advance.unmet.length} unmet)` : ""
      }`,
      confidence: extraction.timeConfidence,
      latencyMs: Date.now() - started,
      mutation: true,
      changeSummary: `Call #${call.id} → test drive #${drive?.id} scheduled ${whenLabel}; confirmations queued${advance.advanced ? `; lead phase → ${advance.advanced}` : ""}`,
      affectedEntities: [
        { type: "test_drive", id: drive?.id ?? 0 },
        { type: "lead", id: updated.id },
        { type: "call_log", id: call.id },
      ],
    });
  } catch (err) {
    logger.error({ err, callLogId: call.id }, "Test-drive intent handling failed");
    await recordAgentRun({
      dealerId: call.dealerId,
      agentKey: AGENT_KEY,
      runType: RUN_TYPE,
      inputSource: "calls",
      refType: "call_log",
      refId: call.id,
      status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}
