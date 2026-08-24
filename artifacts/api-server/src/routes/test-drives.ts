import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  leadsTable,
  testDrivesTable,
  timelineEventsTable,
  type TestDriveStatus,
} from "@workspace/db";
import { activeDealerId } from "../middlewares/rbac";
import {
  checkLeadMutationOwnership,
  LEAD_NOT_OWNED,
} from "../lib/lead-ownership";
import {
  ListTestDrivesQueryParams,
  CreateTestDriveBody,
  UpdateTestDriveParams,
  UpdateTestDriveBody,
} from "@workspace/api-zod";

// ---------------------------------------------------------------------------
// Test drives as first-class records (system of record: test_drives table).
// The lead's testDrive* columns are kept in sync for the pipeline UI whenever
// the ACTIVE (scheduled) drive changes.
// ---------------------------------------------------------------------------

const router: IRouter = Router();

const ALLOWED_TRANSITIONS: Record<TestDriveStatus, TestDriveStatus[]> = {
  scheduled: ["scheduled", "completed", "no_show", "cancelled"],
  completed: ["completed"],
  no_show: ["no_show", "scheduled"],
  cancelled: ["cancelled", "scheduled"],
};

async function syncLeadColumns(
  dealerId: number,
  leadId: number,
): Promise<void> {
  // The lead mirrors its latest scheduled drive (or clears when none left).
  const [active] = await db
    .select()
    .from(testDrivesTable)
    .where(
      and(
        eq(testDrivesTable.dealerId, dealerId),
        eq(testDrivesTable.leadId, leadId),
        eq(testDrivesTable.status, "scheduled"),
      ),
    )
    .orderBy(desc(testDrivesTable.scheduledAt))
    .limit(1);
  await db
    .update(leadsTable)
    .set({
      testDriveAt: active?.scheduledAt ?? null,
      testDriveBranch: active?.branch ?? null,
      testDriveLicence: active?.licenceNumber ?? null,
      testDriveWaiver: active?.waiverAccepted ?? false,
    })
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.dealerId, dealerId)));
}

router.get("/test-drives", async (req, res): Promise<void> => {
  const query = ListTestDrivesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const conditions = [eq(testDrivesTable.dealerId, dealerId)];
  if (query.data.leadId != null)
    conditions.push(eq(testDrivesTable.leadId, query.data.leadId));
  if (query.data.status)
    conditions.push(eq(testDrivesTable.status, query.data.status));
  const rows = await db
    .select()
    .from(testDrivesTable)
    .where(and(...conditions))
    .orderBy(desc(testDrivesTable.scheduledAt))
    .limit(200);
  res.json(rows);
});

router.post("/test-drives", async (req, res): Promise<void> => {
  const body = CreateTestDriveBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(
      and(eq(leadsTable.id, body.data.leadId), eq(leadsTable.dealerId, dealerId)),
    );
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  if (
    (await checkLeadMutationOwnership(res.locals.user, dealerId, lead.id)) ===
    "forbidden"
  ) {
    res.status(403).json(LEAD_NOT_OWNED);
    return;
  }
  const [created] = await db
    .insert(testDrivesTable)
    .values({
      dealerId,
      leadId: lead.id,
      vehicleId: body.data.vehicleId ?? lead.interestedVehicleId ?? null,
      customerId: lead.customerId ?? null,
      status: "scheduled",
      scheduledAt: new Date(body.data.scheduledAt),
      branch: body.data.branch ?? null,
      licenceNumber: body.data.licenceNumber ?? null,
      waiverAccepted: body.data.waiverAccepted ?? false,
      bookedVia: "staff",
    })
    .returning();
  await syncLeadColumns(dealerId, lead.id);
  await db.insert(timelineEventsTable).values({
    dealerId,
    customerId: lead.customerId,
    domain: "leads",
    kind: "test_drive",
    title: "Test drive scheduled",
    detail: `Test drive #${created!.id} booked for ${new Date(body.data.scheduledAt).toISOString()}${body.data.branch ? ` at ${body.data.branch}` : ""}`,
    actor: res.locals.user?.name ?? "Staff",
    refType: "lead",
    refId: lead.id,
  });
  res.status(201).json(created);
});

router.patch("/test-drives/:id", async (req, res): Promise<void> => {
  const params = UpdateTestDriveParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateTestDriveBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const [drive] = await db
    .select()
    .from(testDrivesTable)
    .where(
      and(
        eq(testDrivesTable.id, params.data.id),
        eq(testDrivesTable.dealerId, dealerId),
      ),
    );
  if (!drive) {
    res.status(404).json({ error: "Test drive not found" });
    return;
  }
  if (
    (await checkLeadMutationOwnership(
      res.locals.user,
      dealerId,
      drive.leadId,
    )) === "forbidden"
  ) {
    res.status(403).json(LEAD_NOT_OWNED);
    return;
  }

  const nextStatus = (body.data.status ?? drive.status) as TestDriveStatus;
  if (
    body.data.status &&
    !ALLOWED_TRANSITIONS[drive.status as TestDriveStatus]?.includes(nextStatus)
  ) {
    res.status(422).json({
      error: `A ${drive.status.replace("_", "-")} test drive can't move to ${nextStatus.replace("_", "-")}`,
    });
    return;
  }

  const [updated] = await db
    .update(testDrivesTable)
    .set({
      status: nextStatus,
      scheduledAt: body.data.scheduledAt
        ? new Date(body.data.scheduledAt)
        : drive.scheduledAt,
      branch: body.data.branch !== undefined ? body.data.branch : drive.branch,
      licenceNumber:
        body.data.licenceNumber !== undefined
          ? body.data.licenceNumber
          : drive.licenceNumber,
      waiverAccepted: body.data.waiverAccepted ?? drive.waiverAccepted,
      outcomeNotes:
        body.data.outcomeNotes !== undefined
          ? body.data.outcomeNotes
          : drive.outcomeNotes,
      completedAt:
        nextStatus === "completed" && drive.status !== "completed"
          ? new Date()
          : drive.completedAt,
      cancelledAt:
        nextStatus === "cancelled" && drive.status !== "cancelled"
          ? new Date()
          : nextStatus === "scheduled"
            ? null
            : drive.cancelledAt,
    })
    .where(eq(testDrivesTable.id, drive.id))
    .returning();
  await syncLeadColumns(dealerId, drive.leadId);

  if (body.data.status && body.data.status !== drive.status) {
    const LABEL: Record<TestDriveStatus, string> = {
      scheduled: "rescheduled",
      completed: "completed",
      no_show: "marked as a no-show",
      cancelled: "cancelled",
    };
    await db.insert(timelineEventsTable).values({
      dealerId,
      customerId: drive.customerId,
      domain: "leads",
      kind: "test_drive",
      title: `Test drive ${LABEL[nextStatus]}`,
      detail: body.data.outcomeNotes || `Test drive #${drive.id} ${LABEL[nextStatus]}.`,
      actor: res.locals.user?.name ?? "Staff",
      refType: "lead",
      refId: drive.leadId,
    });
  }
  res.json(updated);
});

export default router;
