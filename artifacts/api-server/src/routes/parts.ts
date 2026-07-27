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
  ReceivePartPurchaseParams,
  ReceivePartPurchaseBody,
  ReceivePartPurchaseResponse,
} from "@workspace/api-zod";
import { jobCardPartsTable, jobCardsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

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
  // status "ordered" creates an open PO awaiting goods; the legacy default
  // ("received") keeps the old immediate-receipt behavior intact.
  const isOrdered = parsed.data.status === "ordered";
  const [purchase] = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(partPurchasesTable)
      .values({
        ...parsed.data,
        // date({mode:"string"}) column: the generated Zod coerces to Date.
        expectedDate:
          parsed.data.expectedDate instanceof Date
            ? parsed.data.expectedDate.toISOString().slice(0, 10)
            : (parsed.data.expectedDate ?? null),
        qtyReceived: isOrdered ? 0 : parsed.data.quantity,
        status: isOrdered ? "ordered" : "received",
        dealerId: part.dealerId,
      })
      .returning();
    if (!isOrdered) {
      await tx
        .update(partsTable)
        .set({
          stock: sql`${partsTable.stock} + ${parsed.data.quantity}`,
          ...(parsed.data.unitCost != null
            ? { unitCost: parsed.data.unitCost }
            : {}),
        })
        .where(eq(partsTable.id, parsed.data.partId));
    }
    return inserted;
  });
  res.status(201).json(CreatePartPurchaseResponse.parse(purchase));
});

router.post("/part-purchases/:id/receive", async (req, res): Promise<void> => {
  const params = ReceivePartPurchaseParams.safeParse(req.params);
  const parsed = ReceivePartPurchaseBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const dealerId = activeDealerId(res);
  const [purchase] = await db
    .select()
    .from(partPurchasesTable)
    .where(
      and(
        eq(partPurchasesTable.id, params.data.id),
        eq(partPurchasesTable.dealerId, dealerId),
      ),
    );
  if (!purchase) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }
  if (purchase.status !== "ordered" && purchase.status !== "partially_received") {
    res.status(422).json({
      error: `Purchase is ${purchase.status} — nothing left to receive`,
    });
    return;
  }
  const remaining = purchase.quantity - purchase.qtyReceived;
  if (parsed.data.qtyReceived > remaining) {
    res.status(422).json({
      error: `Over-receipt: only ${remaining} unit(s) outstanding on this order`,
    });
    return;
  }
  const [part] = await db
    .select()
    .from(partsTable)
    .where(
      and(eq(partsTable.id, purchase.partId), eq(partsTable.dealerId, dealerId)),
    );
  if (!part) {
    res.status(404).json({ error: "Part not found" });
    return;
  }

  const received = parsed.data.qtyReceived;
  const newQtyReceived = purchase.qtyReceived + received;
  // Weighted-average cost: blend the on-hand value with the receipt value.
  const onHand = Math.max(part.stock, 0);
  const newCost =
    purchase.unitCost > 0 && onHand + received > 0
      ? Math.round(
          ((onHand * part.unitCost + received * purchase.unitCost) /
            (onHand + received)) *
            100,
        ) / 100
      : part.unitCost;

  const updated = await db.transaction(async (tx) => {
    const [po] = await tx
      .update(partPurchasesTable)
      .set({
        qtyReceived: newQtyReceived,
        status: newQtyReceived >= purchase.quantity ? "received" : "partially_received",
      })
      .where(
        and(
          eq(partPurchasesTable.id, purchase.id),
          eq(partPurchasesTable.dealerId, dealerId),
        ),
      )
      .returning();
    await tx
      .update(partsTable)
      .set({ stock: sql`${partsTable.stock} + ${received}`, unitCost: newCost })
      .where(
        and(eq(partsTable.id, part.id), eq(partsTable.dealerId, dealerId)),
      );

    // Backorder resolution: fill waiting job-card lines oldest-first while
    // stock lasts, and release job cards that no longer wait on any part.
    let available = onHand + received;
    const waiting = await tx
      .select()
      .from(jobCardPartsTable)
      .where(
        and(
          eq(jobCardPartsTable.dealerId, dealerId),
          eq(jobCardPartsTable.partId, part.id),
          eq(jobCardPartsTable.backordered, true),
        ),
      )
      .orderBy(jobCardPartsTable.createdAt);
    const touchedCards = new Set<number>();
    for (const line of waiting) {
      if (line.quantity > available) continue;
      available -= line.quantity;
      await tx
        .update(jobCardPartsTable)
        .set({ backordered: false })
        .where(eq(jobCardPartsTable.id, line.id));
      await tx
        .update(partsTable)
        .set({ stock: sql`${partsTable.stock} - ${line.quantity}` })
        .where(
          and(eq(partsTable.id, part.id), eq(partsTable.dealerId, dealerId)),
        );
      touchedCards.add(line.jobCardId);
    }
    if (touchedCards.size > 0) {
      const stillWaiting = await tx
        .select({ jobCardId: jobCardPartsTable.jobCardId })
        .from(jobCardPartsTable)
        .where(
          and(
            eq(jobCardPartsTable.dealerId, dealerId),
            inArray(jobCardPartsTable.jobCardId, [...touchedCards]),
            eq(jobCardPartsTable.backordered, true),
          ),
        );
      const blocked = new Set(stillWaiting.map((r) => r.jobCardId));
      const releasable = [...touchedCards].filter((id) => !blocked.has(id));
      if (releasable.length > 0) {
        await tx
          .update(jobCardsTable)
          .set({ status: "in_progress" })
          .where(
            and(
              eq(jobCardsTable.dealerId, dealerId),
              inArray(jobCardsTable.id, releasable),
              eq(jobCardsTable.status, "on_hold"),
            ),
          );
      }
    }
    return po;
  });

  res.json(ReceivePartPurchaseResponse.parse(updated));
});

export default router;
