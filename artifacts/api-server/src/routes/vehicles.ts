import { Router, type IRouter } from "express";
import { eq, desc, and, ilike, or, type SQL } from "drizzle-orm";
import {
  db,
  vehiclesTable,
  VEHICLE_STATUS_TRANSITIONS,
  type VehicleStatus,
} from "@workspace/db";
import {
  CreateVehicleBody,
  UpdateVehicleBody,
  GetVehicleParams,
  UpdateVehicleParams,
  DeleteVehicleParams,
  ListVehiclesQueryParams,
  ListVehiclesResponse,
  GetVehicleResponse,
  UpdateVehicleResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/vehicles", async (req, res): Promise<void> => {
  const query = ListVehiclesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const filters: SQL[] = [];
  if (query.data.status) filters.push(eq(vehiclesTable.status, query.data.status));
  if (query.data.powertrain)
    filters.push(eq(vehiclesTable.powertrain, query.data.powertrain));
  if (query.data.search) {
    const term = `%${query.data.search}%`;
    const searchClause = or(
      ilike(vehiclesTable.make, term),
      ilike(vehiclesTable.model, term),
      ilike(vehiclesTable.bodyType, term),
    );
    if (searchClause) filters.push(searchClause);
  }

  const rows = await db
    .select()
    .from(vehiclesTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(vehiclesTable.featured), desc(vehiclesTable.createdAt));

  res.json(ListVehiclesResponse.parse(rows));
});

router.post("/vehicles", async (req, res): Promise<void> => {
  const parsed = CreateVehicleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [vehicle] = await db
    .insert(vehiclesTable)
    .values(parsed.data)
    .returning();

  res.status(201).json(GetVehicleResponse.parse(vehicle));
});

router.get("/vehicles/:id", async (req, res): Promise<void> => {
  const params = GetVehicleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [vehicle] = await db
    .select()
    .from(vehiclesTable)
    .where(eq(vehiclesTable.id, params.data.id));

  if (!vehicle) {
    res.status(404).json({ error: "Vehicle not found" });
    return;
  }

  res.json(GetVehicleResponse.parse(vehicle));
});

router.patch("/vehicles/:id", async (req, res): Promise<void> => {
  const params = UpdateVehicleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateVehicleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [before] = await db
    .select({ status: vehiclesTable.status })
    .from(vehiclesTable)
    .where(eq(vehiclesTable.id, params.data.id));
  if (!before) {
    res.status(404).json({ error: "Vehicle not found" });
    return;
  }

  // Enforce the stock-status lifecycle (Available→Reserved→Booked→Delivered).
  if (parsed.data.status && parsed.data.status !== before.status) {
    const allowed =
      VEHICLE_STATUS_TRANSITIONS[before.status as VehicleStatus] ?? [];
    if (!allowed.includes(parsed.data.status as VehicleStatus)) {
      res.status(422).json({
        error: `Invalid status transition: ${before.status} → ${parsed.data.status}`,
      });
      return;
    }
  }

  const [vehicle] = await db
    .update(vehiclesTable)
    .set(parsed.data)
    .where(eq(vehiclesTable.id, params.data.id))
    .returning();

  if (!vehicle) {
    res.status(404).json({ error: "Vehicle not found" });
    return;
  }

  res.json(UpdateVehicleResponse.parse(vehicle));
});

router.delete("/vehicles/:id", async (req, res): Promise<void> => {
  const params = DeleteVehicleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [vehicle] = await db
    .delete(vehiclesTable)
    .where(eq(vehiclesTable.id, params.data.id))
    .returning();

  if (!vehicle) {
    res.status(404).json({ error: "Vehicle not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
