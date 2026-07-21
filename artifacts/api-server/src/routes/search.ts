import { Router, type IRouter } from "express";
import { and, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import {
  db,
  customersTable,
  vehiclesTable,
  leadsTable,
  invoicesTable,
  bookingsTable,
  serviceOrdersTable,
} from "@workspace/db";
import { GlobalSearchResponse } from "@workspace/api-zod";
import { activeDealerId, hasPermission } from "../middlewares/rbac";

const router: IRouter = Router();

const LIMIT = 6;

router.get("/search", async (req, res): Promise<void> => {
  const q = String(req.query.q ?? "").trim();
  const user = res.locals.user;
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (q.length < 2) {
    res.json(GlobalSearchResponse.parse({ query: q, groups: [] }));
    return;
  }
  const dealerId = activeDealerId(res);
  const like = `%${q}%`;
  const isNum = /^\d+$/.test(q);
  const idMatch = (col: SQL | unknown) =>
    isNum ? sql`${col} = ${Number(q)}` : undefined;

  const groups: {
    key: string;
    label: string;
    items: { id: number; title: string; subtitle?: string | null; meta?: string | null; href: string }[];
  }[] = [];

  const tasks: Promise<void>[] = [];

  if (hasPermission(user, "customers", "view")) {
    tasks.push(
      db
        .select()
        .from(customersTable)
        .where(
          and(
            eq(customersTable.dealerId, dealerId),
            or(
              ilike(customersTable.name, like),
              ilike(customersTable.email, like),
              ilike(customersTable.phone, like),
              idMatch(customersTable.id),
            ),
          ),
        )
        .limit(LIMIT)
        .then((rows) => {
          if (rows.length)
            groups.push({
              key: "customers",
              label: "Customers",
              items: rows.map((c) => ({
                id: c.id,
                title: c.name,
                subtitle: c.email ?? c.phone ?? null,
                meta: c.loyaltyTier,
                href: `/customers/${c.id}`,
              })),
            });
        }),
    );
  }

  if (hasPermission(user, "inventory", "view")) {
    tasks.push(
      db
        .select()
        .from(vehiclesTable)
        .where(
          and(
            eq(vehiclesTable.dealerId, dealerId),
            or(
              ilike(vehiclesTable.make, like),
              ilike(vehiclesTable.model, like),
              ilike(vehiclesTable.vin, like),
              ilike(vehiclesTable.registration, like),
              idMatch(vehiclesTable.id),
            ),
          ),
        )
        .limit(LIMIT)
        .then((rows) => {
          if (rows.length)
            groups.push({
              key: "vehicles",
              label: "Vehicles",
              items: rows.map((v) => ({
                id: v.id,
                title: `${v.year} ${v.make} ${v.model}`,
                subtitle: v.vin ?? v.powertrain,
                meta: v.status,
                href: `/inventory?vehicle=${v.id}`,
              })),
            });
        }),
    );

    tasks.push(
      db
        .select()
        .from(bookingsTable)
        .where(
          and(
            eq(bookingsTable.dealerId, dealerId),
            or(
              ilike(bookingsTable.customerName, like),
              idMatch(bookingsTable.id),
            ),
          ),
        )
        .limit(LIMIT)
        .then((rows) => {
          if (rows.length)
            groups.push({
              key: "bookings",
              label: "Bookings",
              items: rows.map((b) => ({
                id: b.id,
                title: `Booking #${b.id} · ${b.customerName}`,
                subtitle: `Vehicle #${b.vehicleId}`,
                meta: b.status,
                href: `/inventory?booking=${b.id}`,
              })),
            });
        }),
    );
  }

  if (hasPermission(user, "leads", "view")) {
    tasks.push(
      db
        .select()
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.dealerId, dealerId),
            or(
              ilike(leadsTable.name, like),
              ilike(leadsTable.email, like),
              ilike(leadsTable.phone, like),
              idMatch(leadsTable.id),
            ),
          ),
        )
        .limit(LIMIT)
        .then((rows) => {
          if (rows.length)
            groups.push({
              key: "leads",
              label: "Leads",
              items: rows.map((l) => ({
                id: l.id,
                title: l.name,
                subtitle: l.email ?? l.phone ?? null,
                meta: l.phase,
                href: `/pipeline?lead=${l.id}`,
              })),
            });
        }),
    );
  }

  if (hasPermission(user, "finance", "view")) {
    tasks.push(
      db
        .select()
        .from(invoicesTable)
        .where(
          and(
            eq(invoicesTable.dealerId, dealerId),
            or(
              ilike(invoicesTable.invoiceNumber, like),
              ilike(invoicesTable.customerName, like),
              idMatch(invoicesTable.id),
            ),
          ),
        )
        .limit(LIMIT)
        .then((rows) => {
          if (rows.length)
            groups.push({
              key: "invoices",
              label: "Invoices",
              items: rows.map((i) => ({
                id: i.id,
                title: `${i.invoiceNumber} · ${i.customerName}`,
                subtitle: `$${Math.round(i.amount).toLocaleString("en-US")}`,
                meta: i.status,
                href: `/finance?invoice=${i.id}`,
              })),
            });
        }),
    );
  }

  if (hasPermission(user, "service", "view")) {
    tasks.push(
      db
        .select()
        .from(serviceOrdersTable)
        .where(
          and(
            eq(serviceOrdersTable.dealerId, dealerId),
            or(
              ilike(serviceOrdersTable.customerName, like),
              ilike(serviceOrdersTable.vehicleInfo, like),
              idMatch(serviceOrdersTable.id),
            ),
          ),
        )
        .limit(LIMIT)
        .then((rows) => {
          if (rows.length)
            groups.push({
              key: "service",
              label: "Service",
              items: rows.map((s) => ({
                id: s.id,
                title: `SO #${s.id} · ${s.customerName ?? s.vehicleInfo}`,
                subtitle: s.vehicleInfo,
                meta: s.status,
                href: `/service?order=${s.id}`,
              })),
            });
        }),
    );
  }

  await Promise.all(tasks);

  const ORDER = ["customers", "vehicles", "leads", "invoices", "bookings", "service"];
  groups.sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));

  res.json(GlobalSearchResponse.parse({ query: q, groups }));
});

export default router;
