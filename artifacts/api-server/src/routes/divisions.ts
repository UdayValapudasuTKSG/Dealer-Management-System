import { Router, type IRouter } from "express";
import { asc, eq, and } from "drizzle-orm";
import { db, divisionsTable, dealersTable } from "@workspace/db";
import { ListDivisionsResponse } from "@workspace/api-zod";
import { activeDealerId } from "../middlewares/rbac";

const router: IRouter = Router();

router.get("/divisions", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(divisionsTable)
    .where(eq(divisionsTable.dealerId, activeDealerId(res)))
    .orderBy(asc(divisionsTable.id));
  res.json(ListDivisionsResponse.parse(rows));
});

export default router;

/**
 * Resolve the default division for a dealer: the division whose name matches
 * the dealer's name (CAM Motors dealer → CAM Motors division), else the first.
 */
export async function defaultDivisionId(
  dealerId: number,
): Promise<number | null> {
  const rows = await db
    .select({
      id: divisionsTable.id,
      name: divisionsTable.name,
      dealerName: dealersTable.name,
    })
    .from(divisionsTable)
    .innerJoin(dealersTable, eq(dealersTable.id, divisionsTable.dealerId))
    .where(eq(divisionsTable.dealerId, dealerId))
    .orderBy(asc(divisionsTable.id));
  if (rows.length === 0) return null;
  return (rows.find((r) => r.name === r.dealerName) ?? rows[0]!).id;
}

/** 404-safe check that a divisionId belongs to the active dealer. */
export async function divisionBelongsToDealer(
  divisionId: number,
  dealerId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: divisionsTable.id })
    .from(divisionsTable)
    .where(
      and(
        eq(divisionsTable.id, divisionId),
        eq(divisionsTable.dealerId, dealerId),
      ),
    );
  return !!row;
}
