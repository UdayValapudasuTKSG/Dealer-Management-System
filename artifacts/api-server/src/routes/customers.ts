import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import {
  db,
  customersTable,
  dealsTable,
  appraisalsTable,
  financeApplicationsTable,
  serviceOrdersTable,
  leadsTable,
  vehiclesTable,
  timelineEventsTable,
  gatesTable,
} from "@workspace/db";
import {
  CreateCustomerBody,
  UpdateCustomerBody,
  GetCustomerParams,
  UpdateCustomerParams,
  ListCustomersResponse,
  GetCustomerResponse,
  UpdateCustomerResponse,
  GetCustomerOverviewParams,
  GetCustomerOverviewResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const ACTIVE_DEAL_STAGES = ["desking", "negotiation", "finance", "committed"];

router.get("/customers", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(customersTable)
    .orderBy(desc(customersTable.lifetimeValue));
  res.json(ListCustomersResponse.parse(rows));
});

router.post("/customers", async (req, res): Promise<void> => {
  const parsed = CreateCustomerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [customer] = await db
    .insert(customersTable)
    .values(parsed.data)
    .returning();

  res.status(201).json(GetCustomerResponse.parse(customer));
});

router.get("/customers/:id", async (req, res): Promise<void> => {
  const params = GetCustomerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [customer] = await db
    .select()
    .from(customersTable)
    .where(eq(customersTable.id, params.data.id));

  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  res.json(GetCustomerResponse.parse(customer));
});

router.patch("/customers/:id", async (req, res): Promise<void> => {
  const params = UpdateCustomerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateCustomerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [customer] = await db
    .update(customersTable)
    .set(parsed.data)
    .where(eq(customersTable.id, params.data.id))
    .returning();

  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  res.json(UpdateCustomerResponse.parse(customer));
});

router.get("/customers/:id/overview", async (req, res): Promise<void> => {
  const params = GetCustomerOverviewParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const customerId = params.data.id;

  const [customer] = await db
    .select()
    .from(customersTable)
    .where(eq(customersTable.id, customerId));

  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  const [deals, appraisals, financeApplications, serviceOrders, leads, timeline, gates, vehicles] =
    await Promise.all([
      db.select().from(dealsTable).where(eq(dealsTable.customerId, customerId)),
      db
        .select()
        .from(appraisalsTable)
        .where(eq(appraisalsTable.customerId, customerId)),
      db
        .select()
        .from(financeApplicationsTable)
        .where(eq(financeApplicationsTable.customerId, customerId)),
      db
        .select()
        .from(serviceOrdersTable)
        .where(eq(serviceOrdersTable.customerId, customerId)),
      db.select().from(leadsTable).where(eq(leadsTable.customerId, customerId)),
      db
        .select()
        .from(timelineEventsTable)
        .where(eq(timelineEventsTable.customerId, customerId))
        .orderBy(desc(timelineEventsTable.createdAt)),
      db.select().from(gatesTable).where(eq(gatesTable.customerId, customerId)),
      db.select().from(vehiclesTable),
    ]);

  const vehicleById = new Map(vehicles.map((v) => [v.id, v]));

  // Owned vehicles are derived from delivered deals — the customer took delivery.
  const ownedVehicles = deals
    .filter((d) => d.stage === "delivered")
    .map((d) => vehicleById.get(d.vehicleId))
    .filter((v): v is NonNullable<typeof v> => Boolean(v));

  const activeDeal =
    deals
      .filter((d) => ACTIVE_DEAL_STAGES.includes(d.stage))
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0] ??
    null;

  const openGates = gates.filter((g) => g.status === "pending");

  const overview = {
    customer,
    ownedVehicles,
    activeDeal,
    deals,
    appraisals,
    financeApplications,
    serviceOrders,
    leads,
    timeline,
    openGates,
  };

  res.json(GetCustomerOverviewResponse.parse(overview));
});

export default router;
