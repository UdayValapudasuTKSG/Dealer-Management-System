import { Router, type IRouter } from "express";
import { activeDealerId } from "../middlewares/rbac";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  db,
  partsTable,
  suppliersTable,
  partPurchasesTable,
} from "@workspace/db";
import {
  ListPartsQueryParams,
  ListPartsResponse,
  CreatePartBody,
  CreatePartResponse,
  UpdatePartParams,
  UpdatePartBody,
  UpdatePartResponse,
  ListSuppliersResponse,
  CreateSupplierBody,
  CreateSupplierResponse,
  ListPartPurchasesResponse,
  CreatePartPurchaseBody,
  CreatePartPurchaseResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/parts", async (req, res): Promise<void> => {
  const query = ListPartsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const filters = [eq(partsTable.dealerId, activeDealerId(res))];
  if (query.data.search) {
    const term = `%${query.data.search}%`;
    filters.push(
      or(ilike(partsTable.name, term), ilike(partsTable.sku, term))!,
    );
  }
  if (query.data.lowStock === "1") {
    filters.push(sql`${partsTable.stock} <= ${partsTable.reorderLevel}`);
  }
  const rows = await db
    .select()
    .from(partsTable)
    .where(sql.join(filters, sql` and `))
    .orderBy(partsTable.name);
  res.json(ListPartsResponse.parse(rows));
});

router.post("/parts", async (req, res): Promise<void> => {
  const parsed = CreatePartBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [part] = await db
    .insert(partsTable)
    .values({ ...parsed.data, dealerId: activeDealerId(res) })
    .returning();
  res.status(201).json(CreatePartResponse.parse(part));
});

router.patch("/parts/:id", async (req, res): Promise<void> => {
  const params = UpdatePartParams.safeParse(req.params);
  const parsed = UpdatePartBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const [part] = await db
    .update(partsTable)
    .set(parsed.data)
    .where(
      and(
        eq(partsTable.id, params.data.id),
        eq(partsTable.dealerId, activeDealerId(res)),
      ),
    )
    .returning();
  if (!part) {
    res.status(404).json({ error: "Part not found" });
    return;
  }
  res.json(UpdatePartResponse.parse(part));
});

router.get("/suppliers", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(suppliersTable)
    .where(eq(suppliersTable.dealerId, activeDealerId(res)))
    .orderBy(suppliersTable.name);
  res.json(ListSuppliersResponse.parse(rows));
});

router.post("/suppliers", async (req, res): Promise<void> => {
  const parsed = CreateSupplierBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [supplier] = await db
    .insert(suppliersTable)
    .values({ ...parsed.data, dealerId: activeDealerId(res) })
    .returning();
  res.status(201).json(CreateSupplierResponse.parse(supplier));
});

router.get("/part-purchases", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(partPurchasesTable)
    .where(eq(partPurchasesTable.dealerId, activeDealerId(res)))
    .orderBy(desc(partPurchasesTable.createdAt));
  res.json(ListPartPurchasesResponse.parse(rows));
});

router.post("/part-purchases", async (req, res): Promise<void> => {
  const parsed = CreatePartPurchaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [part] = await db
    .select()
    .from(partsTable)
    .where(
      and(
        eq(partsTable.id, parsed.data.partId),
        eq(partsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!part) {
    res.status(404).json({ error: "Part not found" });
    return;
  }
  const [purchase] = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(partPurchasesTable)
      .values({ ...parsed.data, dealerId: part.dealerId })
      .returning();
    await tx
      .update(partsTable)
      .set({
        stock: sql`${partsTable.stock} + ${parsed.data.quantity}`,
        ...(parsed.data.unitCost != null
          ? { unitCost: parsed.data.unitCost }
          : {}),
      })
      .where(eq(partsTable.id, parsed.data.partId));
    return inserted;
  });
  res.status(201).json(CreatePartPurchaseResponse.parse(purchase));
});

export default router;
