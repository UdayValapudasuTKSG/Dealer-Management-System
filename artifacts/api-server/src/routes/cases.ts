import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  casesTable,
  customersTable,
  timelineEventsTable,
  type CaseStatus,
} from "@workspace/db";
import { activeDealerId } from "../middlewares/rbac";
import {
  ListCasesQueryParams,
  CreateCaseBody,
  UpdateCaseParams,
  UpdateCaseBody,
} from "@workspace/api-zod";

// ---------------------------------------------------------------------------
// Customer cases — complaints / exceptions / escalations with an
// open → in_progress → resolved → closed lifecycle.
// ---------------------------------------------------------------------------

const router: IRouter = Router();

const ALLOWED_TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  open: ["open", "in_progress", "resolved", "closed"],
  in_progress: ["in_progress", "open", "resolved", "closed"],
  resolved: ["resolved", "closed", "in_progress"],
  closed: ["closed", "open"],
};

router.get("/cases", async (req, res): Promise<void> => {
  const query = ListCasesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const conditions = [eq(casesTable.dealerId, dealerId)];
  if (query.data.customerId != null)
    conditions.push(eq(casesTable.customerId, query.data.customerId));
  if (query.data.status)
    conditions.push(eq(casesTable.status, query.data.status));
  if (query.data.refType)
    conditions.push(eq(casesTable.refType, query.data.refType));
  if (query.data.refId != null)
    conditions.push(eq(casesTable.refId, query.data.refId));
  const rows = await db
    .select()
    .from(casesTable)
    .where(and(...conditions))
    .orderBy(desc(casesTable.createdAt))
    .limit(200);
  res.json(rows);
});

router.post("/cases", async (req, res): Promise<void> => {
  const body = CreateCaseBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const dealerId = activeDealerId(res);

  let customerName = body.data.customerName ?? null;
  if (body.data.customerId != null) {
    const [customer] = await db
      .select()
      .from(customersTable)
      .where(
        and(
          eq(customersTable.id, body.data.customerId),
          eq(customersTable.dealerId, dealerId),
        ),
      );
    if (!customer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    customerName = customerName ?? customer.name;
  }

  const [created] = await db
    .insert(casesTable)
    .values({
      dealerId,
      customerId: body.data.customerId ?? null,
      customerName,
      title: body.data.title,
      description: body.data.description ?? null,
      type: body.data.type ?? "complaint",
      severity: body.data.severity ?? "medium",
      status: "open",
      refType: body.data.refType ?? null,
      refId: body.data.refId ?? null,
      assignedTo: body.data.assignedTo ?? null,
      createdBy: res.locals.user?.name ?? null,
    })
    .returning();

  if (body.data.customerId != null) {
    await db.insert(timelineEventsTable).values({
      dealerId,
      customerId: body.data.customerId,
      domain: "customers",
      kind: "note",
      title: `Case opened: ${body.data.title.slice(0, 80)}`,
      detail: body.data.description || `Case #${created!.id} opened.`,
      actor: res.locals.user?.name ?? "Staff",
      refType: "customer",
      refId: body.data.customerId,
    });
  }
  res.status(201).json(created);
});

router.patch("/cases/:id", async (req, res): Promise<void> => {
  const params = UpdateCaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateCaseBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const [existing] = await db
    .select()
    .from(casesTable)
    .where(
      and(eq(casesTable.id, params.data.id), eq(casesTable.dealerId, dealerId)),
    );
  if (!existing) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  const nextStatus = (body.data.status ?? existing.status) as CaseStatus;
  if (
    body.data.status &&
    !ALLOWED_TRANSITIONS[existing.status as CaseStatus]?.includes(nextStatus)
  ) {
    res.status(422).json({
      error: `A ${existing.status.replace("_", " ")} case can't move to ${nextStatus.replace("_", " ")}`,
    });
    return;
  }
  if (
    nextStatus === "resolved" &&
    existing.status !== "resolved" &&
    !(body.data.resolutionNote ?? existing.resolutionNote)
  ) {
    res
      .status(422)
      .json({ error: "A resolution note is required to resolve a case" });
    return;
  }

  const [updated] = await db
    .update(casesTable)
    .set({
      title: body.data.title ?? existing.title,
      description:
        body.data.description !== undefined
          ? body.data.description
          : existing.description,
      type: body.data.type ?? existing.type,
      severity: body.data.severity ?? existing.severity,
      status: nextStatus,
      assignedTo:
        body.data.assignedTo !== undefined
          ? body.data.assignedTo
          : existing.assignedTo,
      resolutionNote:
        body.data.resolutionNote !== undefined
          ? body.data.resolutionNote
          : existing.resolutionNote,
      resolvedAt:
        nextStatus === "resolved" && existing.status !== "resolved"
          ? new Date()
          : nextStatus === "open" || nextStatus === "in_progress"
            ? null
            : existing.resolvedAt,
    })
    .where(eq(casesTable.id, existing.id))
    .returning();

  if (body.data.status && body.data.status !== existing.status && existing.customerId != null) {
    await db.insert(timelineEventsTable).values({
      dealerId,
      customerId: existing.customerId,
      domain: "customers",
      kind: "note",
      title: `Case ${nextStatus.replace("_", " ")}: ${existing.title.slice(0, 60)}`,
      detail:
        body.data.resolutionNote ||
        `Case #${existing.id} moved to ${nextStatus.replace("_", " ")}.`,
      actor: res.locals.user?.name ?? "Staff",
      refType: "customer",
      refId: existing.customerId,
    });
  }
  res.json(updated);
});

export default router;
