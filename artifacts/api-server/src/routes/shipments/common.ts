import type { Request, Response, NextFunction, RequestHandler } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  shipmentsTable,
  shipmentEditLocksTable,
  shipmentEventsTable,
  shipmentSpecsTable,
  type ShipmentSpec,
} from "@workspace/db";
import { activeDealerId, hasPermission, type AuthedUser } from "../../middlewares/rbac";
import { evaluateLease } from "../../lib/shipments/rules";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbLike = Tx | typeof db;

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/** Wrap async handler: maps HttpError/unique violations/zod to JSON. */
export function h(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: "Conflicts with an existing record (duplicate)", code: "duplicate" });
        return;
      }
      if ((err as { name?: string })?.name === "ZodError") {
        res.status(400).json({ error: "Invalid request", issues: (err as { issues?: unknown }).issues });
        return;
      }
      next(err);
    });
  };
}

export function ctx(res: Response): { dealerId: number; user: AuthedUser; actor: string } {
  const user = res.locals.user;
  if (!user) throw new HttpError(401, "Unauthorized");
  return { dealerId: activeDealerId(res), user, actor: user.name || user.email || `user#${user.id}` };
}

export function requirePerm(user: AuthedUser, checks: [string, string][], what: string): void {
  if (!checks.some(([m, c]) => hasPermission(user, m, c)))
    throw new HttpError(403, `Your role is not permitted to ${what}`);
}

export function idParam(req: Request, name: string): number {
  const raw = req.params[name];
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}`);
  return n;
}

export async function loadShipment(tx: DbLike, dealerId: number, id: number, forUpdate = false) {
  const q = tx
    .select()
    .from(shipmentsTable)
    .where(and(eq(shipmentsTable.id, id), eq(shipmentsTable.dealerId, dealerId)));
  const [row] = forUpdate ? await q.for("update") : await q;
  if (!row) throw new HttpError(404, "Shipment not found");
  return row;
}

/**
 * Server-side lease enforcement: the caller must hold an unexpired editor
 * lease on the shipment. Locks the lease row so a concurrent takeover waits.
 */
export async function requireLease(tx: Tx, dealerId: number, shipmentId: number, userId: number) {
  const [lock] = await tx
    .select()
    .from(shipmentEditLocksTable)
    .where(and(eq(shipmentEditLocksTable.shipmentId, shipmentId), eq(shipmentEditLocksTable.dealerId, dealerId)))
    .for("update");
  const state = evaluateLease(lock, userId, new Date());
  if (state === "mine") return;
  if (state === "other")
    throw new HttpError(423, `Read-only: ${lock!.holderName} is editing this shipment`, "locked");
  throw new HttpError(423, "Start editing (acquire the editor lease) before making changes", "lease_required");
}

export async function recordEvent(
  tx: DbLike,
  e: { dealerId: number; shipmentId: number | null; allocationId?: number | null; kind: string; detail: string; actor: string },
) {
  await tx.insert(shipmentEventsTable).values({
    dealerId: e.dealerId,
    shipmentId: e.shipmentId,
    allocationId: e.allocationId ?? null,
    kind: e.kind,
    detail: e.detail,
    actor: e.actor,
  });
}

export function specOut(s: ShipmentSpec, inUse = false) {
  return {
    id: s.id,
    make: s.make,
    model: s.model,
    year: s.year,
    variant: s.variant,
    exteriorColor: s.exteriorColor,
    interiorColor: s.interiorColor,
    status: s.status as "draft" | "approved" | "retired",
    approvedBy: s.approvedBy,
    approvedAt: s.approvedAt,
    createdAt: s.createdAt,
    inUse,
  };
}

export async function specsById(tx: DbLike, dealerId: number, ids: number[]) {
  const map = new Map<number, ShipmentSpec>();
  if (!ids.length) return map;
  const rows = await tx
    .select()
    .from(shipmentSpecsTable)
    .where(and(eq(shipmentSpecsTable.dealerId, dealerId), inArray(shipmentSpecsTable.id, [...new Set(ids)])));
  for (const r of rows) map.set(r.id, r);
  return map;
}

export const sqlCount = sql<number>`count(*)::int`;
