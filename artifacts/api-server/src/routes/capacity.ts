import { Router, type IRouter } from "express";
import { and, eq, gte, lte } from "drizzle-orm";
import {
  db,
  capacityBlocksTable,
  vehiclesTable,
  usersTable,
  dealerUsersTable,
  timelineEventsTable,
} from "@workspace/db";
import {
  ListCapacityBlocksQueryParams,
  ListCapacityBlocksResponseItem,
  CreateCapacityBlockBody,
  CreateCapacityBlockResponse,
  DeleteCapacityBlockParams,
} from "@workspace/api-zod";
import { activeDealerId, hasPermission } from "../middlewares/rbac";

const router: IRouter = Router();

/** Generated zod coerces `format: date` params to Date — store as YYYY-MM-DD. */
function dateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function actorName(res: {
  locals: { user?: { name?: string | null; email?: string | null } };
}): string {
  return res.locals.user?.name ?? res.locals.user?.email ?? "Staff";
}

function canManage(res: {
  locals: { user?: unknown };
}): boolean {
  const user = res.locals.user as
    | Parameters<typeof hasPermission>[0]
    | undefined;
  return !!user && hasPermission(user, "settings", "edit");
}

async function refLabel(
  dealerId: number,
  kind: string,
  refId: number,
): Promise<string | null> {
  if (kind === "vehicle") {
    const [v] = await db
      .select({
        year: vehiclesTable.year,
        make: vehiclesTable.make,
        model: vehiclesTable.model,
        vin: vehiclesTable.vin,
      })
      .from(vehiclesTable)
      .where(
        and(eq(vehiclesTable.id, refId), eq(vehiclesTable.dealerId, dealerId)),
      );
    return v
      ? `${v.year} ${v.make} ${v.model}${v.vin ? ` (${v.vin})` : ""}`
      : null;
  }
  // Advisors must be members of THIS dealership — a bare users-table
  // lookup would let managers create blocks against arbitrary global user IDs.
  const [u] = await db
    .select({ name: usersTable.name, email: usersTable.email })
    .from(usersTable)
    .innerJoin(dealerUsersTable, eq(dealerUsersTable.userId, usersTable.id))
    .where(
      and(
        eq(usersTable.id, refId),
        eq(dealerUsersTable.dealerId, dealerId),
      ),
    );
  return u?.name ?? u?.email ?? null;
}

router.get("/capacity-blocks", async (req, res): Promise<void> => {
  const query = ListCapacityBlocksQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const conds = [eq(capacityBlocksTable.dealerId, dealerId)];
  if (query.data.from)
    conds.push(gte(capacityBlocksTable.date, dateStr(query.data.from)));
  if (query.data.to)
    conds.push(lte(capacityBlocksTable.date, dateStr(query.data.to)));
  const rows = await db
    .select()
    .from(capacityBlocksTable)
    .where(and(...conds))
    .orderBy(capacityBlocksTable.date);
  const enriched = await Promise.all(
    rows.map(async (r) => ({
      ...r,
      refLabel: await refLabel(dealerId, r.kind, r.refId),
    })),
  );
  res.json(enriched.map((r) => ListCapacityBlocksResponseItem.parse(r)));
});

router.post("/capacity-blocks", async (req, res): Promise<void> => {
  if (!canManage(res)) {
    res.status(403).json({
      error: "Only managers can plan test-drive capacity.",
    });
    return;
  }
  const parsed = CreateCapacityBlockBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const label = await refLabel(dealerId, parsed.data.kind, parsed.data.refId);
  if (!label) {
    res.status(404).json({
      error:
        parsed.data.kind === "vehicle"
          ? "Vehicle not found in this dealership"
          : "Advisor not found",
    });
    return;
  }
  const [row] = await db
    .insert(capacityBlocksTable)
    .values({
      dealerId,
      kind: parsed.data.kind,
      refId: parsed.data.refId,
      date: dateStr(parsed.data.date),
      reason: parsed.data.reason ?? null,
      createdBy: actorName(res),
    })
    .onConflictDoNothing()
    .returning();
  const block =
    row ??
    (
      await db
        .select()
        .from(capacityBlocksTable)
        .where(
          and(
            eq(capacityBlocksTable.dealerId, dealerId),
            eq(capacityBlocksTable.kind, parsed.data.kind),
            eq(capacityBlocksTable.refId, parsed.data.refId),
            eq(capacityBlocksTable.date, dateStr(parsed.data.date)),
          ),
        )
    )[0]!;
  if (row) {
    await db.insert(timelineEventsTable).values({
      dealerId,
      domain: "leads",
      kind: "capacity_blocked",
      title: `Test-drive capacity blocked — ${label}`,
      detail: `${label} marked unavailable on ${dateStr(parsed.data.date)}${parsed.data.reason ? ` — ${parsed.data.reason}` : ""}.`,
      actor: actorName(res),
      refType: parsed.data.kind === "vehicle" ? "vehicle" : "user",
      refId: parsed.data.refId,
    });
  }
  res
    .status(201)
    .json(CreateCapacityBlockResponse.parse({ ...block, refLabel: label }));
});

router.delete("/capacity-blocks/:id", async (req, res): Promise<void> => {
  if (!canManage(res)) {
    res.status(403).json({
      error: "Only managers can plan test-drive capacity.",
    });
    return;
  }
  const params = DeleteCapacityBlockParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .delete(capacityBlocksTable)
    .where(
      and(
        eq(capacityBlocksTable.id, params.data.id),
        eq(capacityBlocksTable.dealerId, activeDealerId(res)),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Block not found" });
    return;
  }
  res.status(204).end();
});

export default router;
