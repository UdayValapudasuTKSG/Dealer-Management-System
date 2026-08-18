import { Router, type IRouter } from "express";
import { queueCustomerSync } from "../lib/erpnext/entities";
import { eq, desc, and, or, ilike, sql, isNotNull, isNull } from "drizzle-orm";
import multer from "multer";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  db,
  customersTable,
  contactsTable,
  assetsTable,
  usersTable,
  customerPersonasTable,
  customerNotesTable,
  customerDocumentsTable,
  dealsTable,
  bookingsTable,
  invoicesTable,
  appraisalsTable,
  financeApplicationsTable,
  serviceOrdersTable,
  leadsTable,
  vehiclesTable,
  timelineEventsTable,
  gatesTable,
  insertCustomerDocumentSchema,
  dsarRequestsTable,
  type DsarRequest as DsarRequestRow,
  type CustomerPersona,
  type Customer,
  type Vehicle,
} from "@workspace/db";
import {
  CreateCustomerBody,
  UpdateCustomerBody,
  GetCustomerParams,
  DeleteCustomerParams,
  UpdateCustomerParams,
  ListCustomersQueryParams,
  UpdateAccountRelationsParams,
  UpdateAccountRelationsBody,
  UpdateAccountRelationsResponse,
  ListCustomersResponse,
  GetCustomerResponse,
  UpdateCustomerResponse,
  GetCustomerOverviewParams,
  GetCustomerOverviewResponse,
  GetCustomerPersonaParams,
  GetCustomerPersonaResponse,
  UpsertCustomerPersonaBody,
  UpsertCustomerPersonaParams,
  UpsertCustomerPersonaResponse,
  RecommendCustomerVehicleParams,
  RecommendCustomerVehicleResponse,
  ListCustomerNotesParams,
  ListCustomerNotesResponse,
  CreateCustomerNoteBody,
  CreateCustomerNoteParams,
  CreateCustomerNoteResponse,
  DeleteCustomerNoteParams,
  ListCustomerDocumentsParams,
  ListCustomerDocumentsResponse,
  UploadCustomerDocumentParams,
  UploadCustomerDocumentResponse,
  DeleteCustomerDocumentParams,
  DownloadCustomerDocumentParams,
  ListContactsParams,
  ListContactsResponse,
  CreateContactParams,
  CreateContactBody,
  CreateContactResponse,
  UpdateContactParams,
  UpdateContactBody,
  UpdateContactResponse,
  DeleteContactParams,
  ListAccountAssetsParams,
  ListAccountAssetsResponse,
  GetAccountRelationsParams,
  GetAccountRelationsResponse,
  GetCustomerExportResponse,
  EraseCustomerDataResponse,
} from "@workspace/api-zod";
import { storage } from "../lib/storage";
import { activeDealerId, hasPermission } from "../middlewares/rbac";
import { idempotent } from "../middlewares/idempotency";
import {
  processExport,
  runErasureSaga,
  erasureHolds,
} from "../lib/privacy";
import { notifyManagerNote } from "../lib/notify-triggers";
import { ensurePrimaryContact } from "../lib/accounts";
import {
  guardUntrusted,
  isAgentEnabled,
  recordAgentRun,
} from "../lib/agent-governance";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const ACTIVE_DEAL_STAGES = ["desking", "committed"];

// ---------------------------------------------------------------------------
// Lead score: computed from persona completeness + intent + real activity.
// Returned as a whole-number 0-100 (never multiply by 100 in the UI).
// ---------------------------------------------------------------------------
function computeLeadScore(
  persona: CustomerPersona | null,
  ctx: {
    leads: { aiScore: number }[];
    deals: { stage: string }[];
    customer: Customer;
  },
): number {
  let score = 0;

  if (persona) {
    // Intent signals (up to 55)
    const prob = persona.buyingProbability;
    score +=
      prob === "very_high" ? 30 : prob === "high" ? 22 : prob === "medium" ? 12 : prob === "low" ? 4 : 0;
    if (persona.buyingBudget && persona.buyingBudget > 0) score += 10;
    if (persona.financeRequired != null) score += 3;
    if (persona.tradeIn) score += 5;
    if (persona.marketingConsent) score += 4;
    if ((persona.previousPurchases ?? 0) > 0)
      score += Math.min(8, (persona.previousPurchases ?? 0) * 3);

    // Profile completeness (up to 15)
    const fields = [
      persona.ageGroup,
      persona.incomeRange,
      persona.vehiclePreference,
      persona.brandPreference,
      persona.fuelPreference,
      persona.drivingHabits,
      persona.purchaseMotivation,
      persona.lifestyle,
      persona.communicationPreference,
    ];
    const filled = fields.filter((f) => f != null && f !== "").length;
    score += Math.round((filled / fields.length) * 15);
  }

  // Real activity (up to 30)
  const bestLeadScore = ctx.leads.reduce((m, l) => Math.max(m, l.aiScore), 0);
  score += Math.round((Math.min(bestLeadScore, 100) / 100) * 12);
  if (ctx.deals.some((d) => ACTIVE_DEAL_STAGES.includes(d.stage))) score += 12;
  if (ctx.deals.some((d) => d.stage === "delivered")) score += 6;
  if (ctx.customer.lifetimeValue > 0) score += 5;

  return Math.max(0, Math.min(100, score));
}

async function loadPersonaBundle(customerId: number, dealerId: number) {
  const [[persona], leads, deals, [customer]] = await Promise.all([
    db
      .select()
      .from(customerPersonasTable)
      .where(
        and(
          eq(customerPersonasTable.customerId, customerId),
          eq(customerPersonasTable.dealerId, dealerId),
        ),
      ),
    db
      .select()
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.customerId, customerId),
          eq(leadsTable.dealerId, dealerId),
        ),
      ),
    db
      .select()
      .from(dealsTable)
      .where(
        and(
          eq(dealsTable.customerId, customerId),
          eq(dealsTable.dealerId, dealerId),
        ),
      ),
    db
      .select()
      .from(customersTable)
      .where(
        and(
          eq(customersTable.id, customerId),
          eq(customersTable.dealerId, dealerId),
        ),
      ),
  ]);
  return { persona: persona ?? null, leads, deals, customer: customer ?? null };
}

async function personaPayload(
  customerId: number,
  dealerId: number,
  bundle?: Awaited<ReturnType<typeof loadPersonaBundle>>,
) {
  const b = bundle ?? (await loadPersonaBundle(customerId, dealerId));
  if (!b.customer) return null;

  let aiRecommendedVehicle: Vehicle | null = null;
  if (b.persona?.aiRecommendedVehicleId) {
    const [v] = await db
      .select()
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.id, b.persona.aiRecommendedVehicleId),
          eq(vehiclesTable.dealerId, dealerId),
        ),
      );
    aiRecommendedVehicle = v ?? null;
  }

  const leadScore = computeLeadScore(b.persona, {
    leads: b.leads,
    deals: b.deals,
    customer: b.customer,
  });

  return {
    ...(b.persona ?? {}),
    id: b.persona?.id ?? null,
    customerId,
    aiRecommendedVehicle,
    leadScore,
    updatedAt: b.persona?.updatedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Customers CRUD
// ---------------------------------------------------------------------------
router.get("/customers", async (req, res): Promise<void> => {
  const query = ListCustomersQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const filters = [
    eq(customersTable.dealerId, dealerId),
    isNull(customersTable.deletedAt),
  ];
  if (query.data.accountType) {
    filters.push(eq(customersTable.accountType, query.data.accountType));
  }
  const q = query.data.q?.trim();
  if (q) {
    const like = `%${q}%`;
    const digits = q.replace(/\D/g, "");
    const matchers = [
      ilike(customersTable.name, like),
      ilike(customersTable.email, like),
      ilike(customersTable.taxNumber, like),
    ];
    if (digits.length >= 4) {
      matchers.push(
        sql`regexp_replace(coalesce(${customersTable.phone}, ''), '\\D', '', 'g') LIKE ${`%${digits}%`}`,
      );
    } else {
      matchers.push(ilike(customersTable.phone, like));
    }
    filters.push(or(...matchers)!);
  }
  const rows = await db
    .select()
    .from(customersTable)
    .where(and(...filters))
    .orderBy(desc(customersTable.lifetimeValue));
  res.json(ListCustomersResponse.parse(rows));
});

router.post("/customers", async (req, res): Promise<void> => {
  const parsed = CreateCustomerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const dealerId = activeDealerId(res);

  // Business accounts need a TIN before they can transact (L4).
  if (parsed.data.accountType === "business" && !parsed.data.taxNumber?.trim()) {
    res.status(422).json({
      error: "Business accounts require a TIN (tax number) before creation",
    });
    return;
  }

  // Dedupe: same email or same phone digits already on file → 409 with the
  // existing account id so the client can link instead of duplicating.
  const email = parsed.data.email?.trim();
  const phoneDigits = (parsed.data.phone ?? "").replace(/\D/g, "");
  const dupMatchers = [];
  if (email) dupMatchers.push(ilike(customersTable.email, email));
  if (phoneDigits.length >= 7) {
    dupMatchers.push(
      sql`regexp_replace(coalesce(${customersTable.phone}, ''), '\\D', '', 'g') = ${phoneDigits}`,
    );
  }
  if (dupMatchers.length > 0) {
    const [dup] = await db
      .select({ id: customersTable.id, name: customersTable.name })
      .from(customersTable)
      .where(
        and(
          eq(customersTable.dealerId, dealerId),
          isNull(customersTable.deletedAt),
          or(...dupMatchers)!,
        ),
      )
      .limit(1);
    if (dup) {
      res.status(409).json({
        error: `An account with the same email or phone already exists (${dup.name})`,
        existingId: dup.id,
      });
      return;
    }
  }

  const [customer] = await db
    .insert(customersTable)
    .values({ ...parsed.data, dealerId })
    .returning();

  // Every account carries a primary contact (the Pre-Book checklist depends
  // on it) — mirror the account's own details as the first contact.
  if (customer) {
    await ensurePrimaryContact(dealerId, customer.id, {
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
    });
    // ERPNext two-way sync: mirror the new account as an ERPNext Customer.
    queueCustomerSync(dealerId, customer.id);
  }

  res.status(201).json(GetCustomerResponse.parse(customer));
});

// Soft-delete an account. Blocked while money or bookings reference it —
// deals, invoices or bookings on file mean the record must be kept (use the
// DSAR erasure flow for GDPR removal instead).
router.delete("/customers/:id", async (req, res): Promise<void> => {
  const params = DeleteCustomerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dealerId = activeDealerId(res);

  const [customer] = await db
    .select({ id: customersTable.id })
    .from(customersTable)
    .where(
      and(
        eq(customersTable.id, params.data.id),
        eq(customersTable.dealerId, dealerId),
        isNull(customersTable.deletedAt),
      ),
    );
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  const [[deals], [invoices], [bookings]] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(dealsTable)
      .where(and(eq(dealsTable.customerId, customer.id), eq(dealsTable.dealerId, dealerId))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.customerId, customer.id), eq(invoicesTable.dealerId, dealerId))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(bookingsTable)
      .where(and(eq(bookingsTable.customerId, customer.id), eq(bookingsTable.dealerId, dealerId))),
  ]);
  const blockers: string[] = [];
  if ((deals?.n ?? 0) > 0) blockers.push(`${deals!.n} deal(s)`);
  if ((invoices?.n ?? 0) > 0) blockers.push(`${invoices!.n} invoice(s)`);
  if ((bookings?.n ?? 0) > 0) blockers.push(`${bookings!.n} booking(s)`);
  if (blockers.length > 0) {
    res.status(409).json({
      error: `This account cannot be deleted — it still has ${blockers.join(", ")} on file. Use the privacy erasure flow if the customer requested data removal.`,
    });
    return;
  }

  await db
    .update(customersTable)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(customersTable.id, customer.id), eq(customersTable.dealerId, dealerId)));
  // ERPNext sync: disable (not delete) the mapped ERPNext Customer.
  queueCustomerSync(dealerId, customer.id);
  // Unlink open leads so they can be re-promoted to a fresh account.
  await db
    .update(leadsTable)
    .set({ customerId: null })
    .where(and(eq(leadsTable.customerId, customer.id), eq(leadsTable.dealerId, dealerId)));

  res.status(204).end();
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
    .where(
      and(
        eq(customersTable.id, params.data.id),
        eq(customersTable.dealerId, activeDealerId(res)),
        isNull(customersTable.deletedAt),
      ),
    );

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

  // Household / parent-business linking guards.
  if (parsed.data.parentAccountId != null) {
    if (parsed.data.parentAccountId === params.data.id) {
      res.status(422).json({ error: "An account cannot be its own parent" });
      return;
    }
    const [parent] = await db
      .select({
        id: customersTable.id,
        parentAccountId: customersTable.parentAccountId,
      })
      .from(customersTable)
      .where(
        and(
          eq(customersTable.id, parsed.data.parentAccountId),
          eq(customersTable.dealerId, activeDealerId(res)),
        ),
      );
    if (!parent) {
      res.status(404).json({ error: "Parent account not found" });
      return;
    }
    if (parent.parentAccountId === params.data.id) {
      res.status(422).json({
        error:
          "That account is already grouped under this one — unlink it first",
      });
      return;
    }
  }

  const [customer] = await db
    .update(customersTable)
    // updatedAt drives the ERPNext two-way sync last-write-wins check.
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(
      and(
        eq(customersTable.id, params.data.id),
        eq(customersTable.dealerId, activeDealerId(res)),
      ),
    )
    .returning();

  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  // ERPNext two-way sync: push the edit to the mapped ERPNext Customer.
  queueCustomerSync(customer.dealerId, customer.id);

  res.json(UpdateCustomerResponse.parse(customer));
});

// ---------------------------------------------------------------------------
// Contacts, Assets & Relations (account structure)
// ---------------------------------------------------------------------------

async function accountOr404(
  id: number,
  dealerId: number,
): Promise<typeof customersTable.$inferSelect | null> {
  const [account] = await db
    .select()
    .from(customersTable)
    .where(
      and(
        eq(customersTable.id, id),
        eq(customersTable.dealerId, dealerId),
        isNull(customersTable.deletedAt),
      ),
    );
  return account ?? null;
}

type AssetRow = typeof assetsTable.$inferSelect;

/** Enrich raw asset rows with vehicle label/image, advisor name and service history stats. */
async function enrichAssets(rows: AssetRow[], dealerId: number) {
  if (rows.length === 0) return [];
  const [vehicles, advisors, orders] = await Promise.all([
    db.select().from(vehiclesTable).where(eq(vehiclesTable.dealerId, dealerId)),
    db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email }).from(usersTable),
    db
      .select()
      .from(serviceOrdersTable)
      .where(eq(serviceOrdersTable.dealerId, dealerId)),
  ]);
  const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
  const advisorById = new Map(advisors.map((u) => [u.id, u]));

  return rows.map((a) => {
    const v = vehicleById.get(a.vehicleId);
    const label = v ? `${v.year} ${v.make} ${v.model}` : null;
    // Service orders carry free-text vehicleInfo — match by account + model text.
    const related = orders.filter(
      (o) =>
        o.customerId === a.accountId &&
        v != null &&
        o.vehicleInfo.toLowerCase().includes(v.model.toLowerCase()),
    );
    const lastServiceAt =
      related.length > 0
        ? related
            .map((o) => o.createdAt)
            .sort((x, y) => +new Date(y) - +new Date(x))[0]
        : null;
    const advisor = a.serviceAdvisorUserId
      ? advisorById.get(a.serviceAdvisorUserId)
      : undefined;
    return {
      ...a,
      vehicleLabel: label,
      vehicleImageUrl: v?.imageUrl ?? null,
      registration: v?.registration ?? null,
      vin: v?.vin ?? null,
      serviceAdvisorName: advisor
        ? (advisor.name ?? advisor.email ?? `User #${advisor.id}`)
        : null,
      serviceOrderCount: related.length,
      lastServiceAt,
    };
  });
}

const accountSummary = (c: typeof customersTable.$inferSelect) => ({
  id: c.id,
  name: c.name,
  accountType: c.accountType,
  email: c.email,
  phone: c.phone,
});

async function relationsFor(
  account: typeof customersTable.$inferSelect,
  dealerId: number,
) {
  const [parent, children] = await Promise.all([
    account.parentAccountId
      ? accountOr404(account.parentAccountId, dealerId)
      : Promise.resolve(null),
    db
      .select()
      .from(customersTable)
      .where(
        and(
          eq(customersTable.parentAccountId, account.id),
          eq(customersTable.dealerId, dealerId),
        ),
      ),
  ]);
  return {
    parent: parent ? accountSummary(parent) : null,
    children: children.map(accountSummary),
  };
}

router.get("/customers/:id/contacts", async (req, res): Promise<void> => {
  const params = ListContactsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  if (!(await accountOr404(params.data.id, dealerId))) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  const rows = await db
    .select()
    .from(contactsTable)
    .where(
      and(
        eq(contactsTable.accountId, params.data.id),
        eq(contactsTable.dealerId, dealerId),
      ),
    )
    .orderBy(desc(contactsTable.isPrimary), desc(contactsTable.createdAt));
  res.json(ListContactsResponse.parse(rows));
});

router.post("/customers/:id/contacts", async (req, res): Promise<void> => {
  const params = CreateContactParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateContactBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  if (!(await accountOr404(params.data.id, dealerId))) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  // Only one primary contact per account: creating a second primary is a
  // 422 — demote the existing one first (PATCH), which stays the explicit
  // "make primary" flow.
  if (parsed.data.isPrimary) {
    const [existingPrimary] = await db
      .select({ id: contactsTable.id })
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.accountId, params.data.id),
          eq(contactsTable.dealerId, dealerId),
          eq(contactsTable.isPrimary, true),
        ),
      );
    if (existingPrimary) {
      res.status(422).json({
        error:
          "This account already has a primary contact — set the new contact as primary from the contact list instead",
        unmet: ["primary_exists"],
      });
      return;
    }
  }
  const [contact] = await db
    .insert(contactsTable)
    .values({
      dealerId,
      accountId: params.data.id,
      name: parsed.data.name,
      title: parsed.data.title ?? null,
      email: parsed.data.email ?? null,
      phone: parsed.data.phone ?? null,
      isPrimary: parsed.data.isPrimary ?? false,
    })
    .returning();
  res.status(201).json(CreateContactResponse.parse(contact));
});

router.patch(
  "/customers/:id/contacts/:contactId",
  async (req, res): Promise<void> => {
    const params = UpdateContactParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = UpdateContactBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const dealerId = activeDealerId(res);
    if (parsed.data.isPrimary === true) {
      await db
        .update(contactsTable)
        .set({ isPrimary: false })
        .where(
          and(
            eq(contactsTable.accountId, params.data.id),
            eq(contactsTable.dealerId, dealerId),
          ),
        );
    }
    const [contact] = await db
      .update(contactsTable)
      .set(parsed.data)
      .where(
        and(
          eq(contactsTable.id, params.data.contactId),
          eq(contactsTable.accountId, params.data.id),
          eq(contactsTable.dealerId, dealerId),
        ),
      )
      .returning();
    if (!contact) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }
    res.json(UpdateContactResponse.parse(contact));
  },
);

router.delete(
  "/customers/:id/contacts/:contactId",
  async (req, res): Promise<void> => {
    const params = DeleteContactParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const deleted = await db
      .delete(contactsTable)
      .where(
        and(
          eq(contactsTable.id, params.data.contactId),
          eq(contactsTable.accountId, params.data.id),
          eq(contactsTable.dealerId, activeDealerId(res)),
        ),
      )
      .returning();
    if (deleted.length === 0) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }
    res.status(204).end();
  },
);

router.get("/customers/:id/assets", async (req, res): Promise<void> => {
  const params = ListAccountAssetsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  if (!(await accountOr404(params.data.id, dealerId))) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  const rows = await db
    .select()
    .from(assetsTable)
    .where(
      and(
        eq(assetsTable.accountId, params.data.id),
        eq(assetsTable.dealerId, dealerId),
      ),
    )
    .orderBy(desc(assetsTable.deliveredAt));
  res.json(ListAccountAssetsResponse.parse(await enrichAssets(rows, dealerId)));
});

router.get("/customers/:id/relations", async (req, res): Promise<void> => {
  const params = GetAccountRelationsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const account = await accountOr404(params.data.id, dealerId);
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  res.json(
    GetAccountRelationsResponse.parse(await relationsFor(account, dealerId)),
  );
});

// Link (or unlink) an account under a parent — household grouping for
// person accounts, subsidiary for business accounts. The relation type is
// derived from the parent's accountType; the client-provided hint is only
// validated for consistency.
router.put("/customers/:id/relations", async (req, res): Promise<void> => {
  const params = UpdateAccountRelationsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateAccountRelationsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const account = await accountOr404(params.data.id, dealerId);
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  const parentId = parsed.data.parentAccountId;
  if (parentId != null) {
    if (parentId === params.data.id) {
      res.status(422).json({ error: "An account cannot be its own parent" });
      return;
    }
    const [parent] = await db
      .select({
        id: customersTable.id,
        parentAccountId: customersTable.parentAccountId,
        accountType: customersTable.accountType,
      })
      .from(customersTable)
      .where(
        and(
          eq(customersTable.id, parentId),
          eq(customersTable.dealerId, dealerId),
        ),
      );
    if (!parent) {
      // Cross-dealer / unknown parent: forbidden rather than not-found so the
      // caller can't probe other dealers' account ids.
      res.status(403).json({ error: "Parent account is not accessible" });
      return;
    }
    // Walk the full ancestor chain so multi-hop cycles (A←B←C then A under C)
    // are rejected, not just the direct two-node inversion.
    let ancestorId: number | null = parent.parentAccountId;
    let hops = 0;
    while (ancestorId != null && hops < 50) {
      if (ancestorId === params.data.id) {
        res.status(422).json({
          error:
            "That account is already grouped under this one — unlink it first",
        });
        return;
      }
      const [ancestor] = await db
        .select({ parentAccountId: customersTable.parentAccountId })
        .from(customersTable)
        .where(
          and(
            eq(customersTable.id, ancestorId),
            eq(customersTable.dealerId, dealerId),
          ),
        );
      ancestorId = ancestor?.parentAccountId ?? null;
      hops += 1;
    }
    if (
      parsed.data.relationType === "subsidiary" &&
      parent.accountType !== "business"
    ) {
      res.status(422).json({
        error: "A subsidiary link requires a business parent account",
      });
      return;
    }
    if (
      parsed.data.relationType === "household" &&
      parent.accountType !== "person"
    ) {
      res.status(422).json({
        error: "A household link requires a person parent account",
      });
      return;
    }
  }

  const [updated] = await db
    .update(customersTable)
    .set({ parentAccountId: parentId })
    .where(
      and(
        eq(customersTable.id, params.data.id),
        eq(customersTable.dealerId, dealerId),
      ),
    )
    .returning();

  res.json(
    UpdateAccountRelationsResponse.parse(
      await relationsFor(updated!, dealerId),
    ),
  );
});

// ---------------------------------------------------------------------------
// Persona
// ---------------------------------------------------------------------------
router.get("/customers/:id/persona", async (req, res): Promise<void> => {
  const params = GetCustomerPersonaParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const payload = await personaPayload(params.data.id, activeDealerId(res));
  if (!payload) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  res.json(GetCustomerPersonaResponse.parse(payload));
});

router.put("/customers/:id/persona", async (req, res): Promise<void> => {
  const params = UpsertCustomerPersonaParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpsertCustomerPersonaBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const customerId = params.data.id;
  const [customer] = await db
    .select()
    .from(customersTable)
    .where(
      and(
        eq(customersTable.id, customerId),
        eq(customersTable.dealerId, dealerId),
      ),
    );
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  await db
    .insert(customerPersonasTable)
    .values({ ...body.data, customerId, dealerId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: customerPersonasTable.customerId,
      set: { ...body.data, updatedAt: new Date() },
    });

  const payload = await personaPayload(customerId, dealerId);
  res.json(UpsertCustomerPersonaResponse.parse(payload));
});

router.post(
  "/customers/:id/persona/recommend",
  async (req, res): Promise<void> => {
    const params = RecommendCustomerVehicleParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const dealerId = activeDealerId(res);
    const customerId = params.data.id;
    const bundle = await loadPersonaBundle(customerId, dealerId);
    if (!bundle.customer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const vehicles = await db
      .select()
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.status, "available"),
          eq(vehiclesTable.dealerId, dealerId),
        ),
      );

    if (vehicles.length === 0) {
      res.status(502).json({ error: "No available inventory to recommend from" });
      return;
    }

    const p = bundle.persona;
    const personaLines = p
      ? [
          p.ageGroup && `Age group: ${p.ageGroup}`,
          p.incomeRange && `Income range: ${p.incomeRange}`,
          p.buyingBudget && `Buying budget: $${p.buyingBudget.toLocaleString()}`,
          p.familySize != null && `Family size: ${p.familySize}`,
          p.vehiclePreference && `Vehicle preference: ${p.vehiclePreference}`,
          p.brandPreference && `Brand preference: ${p.brandPreference}`,
          p.fuelPreference && `Fuel preference: ${p.fuelPreference}`,
          p.drivingHabits && `Driving habits: ${p.drivingHabits}`,
          p.purchaseMotivation && `Purchase motivation: ${p.purchaseMotivation}`,
          p.lifestyle && `Lifestyle: ${p.lifestyle}`,
          p.financeRequired != null &&
            `Finance required: ${p.financeRequired ? "yes" : "no"}`,
          p.tradeIn != null && `Trade-in: ${p.tradeIn ? "yes" : "no"}`,
        ]
          .filter(Boolean)
          .join("\n")
      : "(no persona captured yet — infer from customer record)";

    const inventoryLines = vehicles
      .slice(0, 40)
      .map(
        (v) =>
          `- id ${v.id}: ${v.year} ${v.make} ${v.model}, ${v.powertrain}, $${v.price.toLocaleString()}`,
      )
      .join("\n");

    const prompt = [
      `You are AURA, the AI concierge of an ultra-premium automotive dealership.`,
      `Recommend the single best vehicle from live inventory for this client.`,
      ``,
      `Client: ${bundle.customer.name}${bundle.customer.occupation ? `, ${bundle.customer.occupation}` : ""}${bundle.customer.city ? `, based in ${bundle.customer.city}` : ""}`,
      `Persona:`,
      guardUntrusted("customer_persona", personaLines),
      ``,
      `Available inventory:`,
      inventoryLines,
      ``,
      `Return ONLY a JSON object (no markdown) with exactly these keys:`,
      `{ "vehicleId": number, "reason": string }`,
      `The vehicleId MUST be one of the ids listed above. The reason is 1-2 sentences, warm and confident, referencing the client's persona.`,
    ].join("\n");

    if (!(await isAgentEnabled(dealerId, "persona_recommend"))) {
      await recordAgentRun({
        dealerId,
        agentKey: "persona_recommend",
        runType: "vehicle_recommendation",
        inputSource: "customers",
        refType: "customer",
        refId: customerId,
        status: "blocked",
        errorMessage: "Agent paused by dealer kill switch",
      });
      res.status(409).json({ error: "The concierge agent is paused for this dealership" });
      return;
    }
    const startedAt = Date.now();
    try {
      const message = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      });
      const textBlock = message.content.find((b) => b.type === "text");
      const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart === -1 || jsonEnd === -1) {
        req.log.error({ raw }, "Vehicle recommendation returned no JSON");
        res.status(502).json({ error: "The concierge could not decide" });
        return;
      }
      let candidate: { vehicleId?: unknown; reason?: unknown };
      try {
        candidate = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      } catch {
        req.log.error({ raw }, "Vehicle recommendation returned invalid JSON");
        res.status(502).json({ error: "The concierge could not decide" });
        return;
      }
      const vehicleId = Number(candidate.vehicleId);
      const reason =
        typeof candidate.reason === "string" ? candidate.reason : null;
      if (!vehicles.some((v) => v.id === vehicleId) || !reason) {
        req.log.error({ candidate }, "Vehicle recommendation invalid payload");
        res.status(502).json({ error: "The concierge picked an unknown vehicle" });
        return;
      }

      await db
        .insert(customerPersonasTable)
        .values({
          customerId,
          dealerId,
          aiRecommendedVehicleId: vehicleId,
          aiRecommendationReason: reason,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: customerPersonasTable.customerId,
          set: {
            aiRecommendedVehicleId: vehicleId,
            aiRecommendationReason: reason,
            updatedAt: new Date(),
          },
        });

      await recordAgentRun({
        dealerId,
        agentKey: "persona_recommend",
        runType: "vehicle_recommendation",
        inputSource: "customers",
        inputSummary: `Customer #${customerId}`,
        outputSummary: `Recommended vehicle #${vehicleId}: ${reason}`,
        refType: "customer",
        refId: customerId,
        latencyMs: Date.now() - startedAt,
        mutation: true,
      });
      const payload = await personaPayload(customerId, dealerId);
      res.json(RecommendCustomerVehicleResponse.parse(payload));
    } catch (err) {
      req.log.error({ err }, "Vehicle recommendation request failed");
      await recordAgentRun({
        dealerId,
        agentKey: "persona_recommend",
        runType: "vehicle_recommendation",
        inputSource: "customers",
        refType: "customer",
        refId: customerId,
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - startedAt,
      });
      res.status(502).json({ error: "The concierge is unavailable right now" });
    }
  },
);

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------
router.get("/customers/:id/notes", async (req, res): Promise<void> => {
  const params = ListCustomerNotesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(customerNotesTable)
    .where(
      and(
        eq(customerNotesTable.customerId, params.data.id),
        eq(customerNotesTable.dealerId, activeDealerId(res)),
      ),
    )
    .orderBy(desc(customerNotesTable.createdAt));
  res.json(ListCustomerNotesResponse.parse(rows));
});

router.post("/customers/:id/notes", async (req, res): Promise<void> => {
  const params = CreateCustomerNoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = CreateCustomerNoteBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const [customer] = await db
    .select()
    .from(customersTable)
    .where(
      and(
        eq(customersTable.id, params.data.id),
        eq(customersTable.dealerId, dealerId),
      ),
    );
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const author =
    res.locals.user?.name ?? res.locals.user?.email ?? null;
  const [note] = await db
    .insert(customerNotesTable)
    .values({ customerId: params.data.id, dealerId, body: body.data.body, author })
    .returning();

  // R6.2 #15 Manager note → the customer's owning advisor (most recent lead
  // owner), In-App only, skipping self-notes.
  const [ownedLead] = await db
    .select({ ownerUserId: leadsTable.ownerUserId })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.customerId, params.data.id),
        eq(leadsTable.dealerId, dealerId),
        isNotNull(leadsTable.ownerUserId),
      ),
    )
    .orderBy(desc(leadsTable.createdAt))
    .limit(1);
  if (ownedLead?.ownerUserId && ownedLead.ownerUserId !== res.locals.user?.id) {
    notifyManagerNote({
      dealerId,
      noteId: note!.id,
      advisorUserId: ownedLead.ownerUserId,
      authorName: author ?? "Staff",
      excerpt: `${customer.name}: ${body.data.body.slice(0, 140)}`,
      link: `/customers/${customer.id}`,
    });
  }

  res.status(201).json(CreateCustomerNoteResponse.parse(note));
});

router.delete(
  "/customers/:id/notes/:noteId",
  async (req, res): Promise<void> => {
    const params = DeleteCustomerNoteParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await db
      .delete(customerNotesTable)
      .where(
        and(
          eq(customerNotesTable.id, params.data.noteId),
          eq(customerNotesTable.customerId, params.data.id),
          eq(customerNotesTable.dealerId, activeDealerId(res)),
        ),
      );
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------
router.get("/customers/:id/documents", async (req, res): Promise<void> => {
  const params = ListCustomerDocumentsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(customerDocumentsTable)
    .where(
      and(
        eq(customerDocumentsTable.customerId, params.data.id),
        eq(customerDocumentsTable.dealerId, activeDealerId(res)),
      ),
    )
    .orderBy(desc(customerDocumentsTable.createdAt));
  res.json(ListCustomerDocumentsResponse.parse(rows));
});

router.post(
  "/customers/:id/documents",
  upload.single("file"),
  async (req, res): Promise<void> => {
    const params = UploadCustomerDocumentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No file provided (field name: file)" });
      return;
    }
    const docType = insertCustomerDocumentSchema.shape.type.safeParse(
      req.body?.type ?? "other",
    );
    if (!docType.success) {
      res.status(400).json({ error: "Invalid document type" });
      return;
    }
    const dealerId = activeDealerId(res);
    const [customer] = await db
      .select()
      .from(customersTable)
      .where(
        and(
          eq(customersTable.id, params.data.id),
          eq(customersTable.dealerId, dealerId),
        ),
      );
    if (!customer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }

    const key = await storage.save(req.file.buffer, req.file.originalname);
    const uploadedBy =
      res.locals.user?.name ?? res.locals.user?.email ?? null;
    const [doc] = await db
      .insert(customerDocumentsTable)
      .values({
        customerId: params.data.id,
        dealerId,
        type: docType.data,
        fileName: req.file.originalname,
        storageKey: key,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        uploadedBy,
      })
      .returning();
    res.status(201).json(UploadCustomerDocumentResponse.parse(doc));
  },
);

router.get(
  "/customers/:id/documents/:docId/download",
  async (req, res): Promise<void> => {
    const params = DownloadCustomerDocumentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [doc] = await db
      .select()
      .from(customerDocumentsTable)
      .where(
        and(
          eq(customerDocumentsTable.id, params.data.docId),
          eq(customerDocumentsTable.customerId, params.data.id),
          eq(customerDocumentsTable.dealerId, activeDealerId(res)),
        ),
      );
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    try {
      const stream = await storage.stream(doc.storageKey);
      res.setHeader("Content-Type", doc.mimeType);
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${doc.fileName.replace(/"/g, "")}"`,
      );
      stream.pipe(res);
    } catch (err) {
      req.log.error({ err, docId: doc.id }, "Document file missing on disk");
      res.status(404).json({ error: "Document file not found" });
    }
  },
);

router.delete(
  "/customers/:id/documents/:docId",
  async (req, res): Promise<void> => {
    const params = DeleteCustomerDocumentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [doc] = await db
      .select()
      .from(customerDocumentsTable)
      .where(
        and(
          eq(customerDocumentsTable.id, params.data.docId),
          eq(customerDocumentsTable.customerId, params.data.id),
          eq(customerDocumentsTable.dealerId, activeDealerId(res)),
        ),
      );
    if (doc) {
      await storage.delete(doc.storageKey);
      await db
        .delete(customerDocumentsTable)
        .where(eq(customerDocumentsTable.id, doc.id));
    }
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// Customer 360 overview
// ---------------------------------------------------------------------------
router.get("/customers/:id/overview", async (req, res): Promise<void> => {
  const params = GetCustomerOverviewParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const customerId = params.data.id;
  const dealerId = activeDealerId(res);

  const [customer] = await db
    .select()
    .from(customersTable)
    .where(
      and(
        eq(customersTable.id, customerId),
        eq(customersTable.dealerId, dealerId),
      ),
    );

  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  const [
    deals,
    appraisals,
    financeApplications,
    serviceOrders,
    leads,
    timeline,
    gates,
    vehicles,
    notes,
    documents,
    [personaRow],
    contacts,
    assetRows,
  ] = await Promise.all([
    db
      .select()
      .from(dealsTable)
      .where(
        and(
          eq(dealsTable.customerId, customerId),
          eq(dealsTable.dealerId, dealerId),
        ),
      ),
    db
      .select()
      .from(appraisalsTable)
      .where(
        and(
          eq(appraisalsTable.customerId, customerId),
          eq(appraisalsTable.dealerId, dealerId),
        ),
      ),
    db
      .select()
      .from(financeApplicationsTable)
      .where(
        and(
          eq(financeApplicationsTable.customerId, customerId),
          eq(financeApplicationsTable.dealerId, dealerId),
        ),
      ),
    db
      .select()
      .from(serviceOrdersTable)
      .where(
        and(
          eq(serviceOrdersTable.customerId, customerId),
          eq(serviceOrdersTable.dealerId, dealerId),
        ),
      ),
    db
      .select()
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.customerId, customerId),
          eq(leadsTable.dealerId, dealerId),
        ),
      ),
    db
      .select()
      .from(timelineEventsTable)
      .where(
        and(
          eq(timelineEventsTable.customerId, customerId),
          eq(timelineEventsTable.dealerId, dealerId),
        ),
      )
      .orderBy(desc(timelineEventsTable.createdAt)),
    db
      .select()
      .from(gatesTable)
      .where(
        and(
          eq(gatesTable.customerId, customerId),
          eq(gatesTable.dealerId, dealerId),
        ),
      ),
    db.select().from(vehiclesTable).where(eq(vehiclesTable.dealerId, dealerId)),
    db
      .select()
      .from(customerNotesTable)
      .where(
        and(
          eq(customerNotesTable.customerId, customerId),
          eq(customerNotesTable.dealerId, dealerId),
        ),
      )
      .orderBy(desc(customerNotesTable.createdAt)),
    db
      .select()
      .from(customerDocumentsTable)
      .where(
        and(
          eq(customerDocumentsTable.customerId, customerId),
          eq(customerDocumentsTable.dealerId, dealerId),
        ),
      )
      .orderBy(desc(customerDocumentsTable.createdAt)),
    db
      .select()
      .from(customerPersonasTable)
      .where(
        and(
          eq(customerPersonasTable.customerId, customerId),
          eq(customerPersonasTable.dealerId, dealerId),
        ),
      ),
    db
      .select()
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.accountId, customerId),
          eq(contactsTable.dealerId, dealerId),
        ),
      )
      .orderBy(desc(contactsTable.isPrimary), desc(contactsTable.createdAt)),
    db
      .select()
      .from(assetsTable)
      .where(
        and(
          eq(assetsTable.accountId, customerId),
          eq(assetsTable.dealerId, dealerId),
        ),
      )
      .orderBy(desc(assetsTable.deliveredAt)),
  ]);

  const [assets, relations] = await Promise.all([
    enrichAssets(assetRows, dealerId),
    relationsFor(customer, dealerId),
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

  const persona = await personaPayload(customerId, dealerId, {
    persona: personaRow ?? null,
    leads,
    deals,
    customer,
  });

  const overview = {
    customer,
    contacts,
    assets,
    relations,
    persona,
    notes,
    documents,
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

// ---------------------------------------------------------------------------
// R10.4 / R10.5 — data-subject requests (privacy/DSAR). Both are 202 async.
// ---------------------------------------------------------------------------

router.get("/customers/:id/export", async (req, res): Promise<void> => {
  const params = GetCustomerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const [customer] = await db
    .select({ id: customersTable.id })
    .from(customersTable)
    .where(
      and(
        eq(customersTable.id, params.data.id),
        eq(customersTable.dealerId, dealerId),
      ),
    );
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const actor =
    res.locals.user?.name ?? res.locals.user?.email ?? "unknown";
  const [request] = await db
    .insert(dsarRequestsTable)
    .values({
      dealerId,
      customerId: customer.id,
      kind: "export",
      status: "processing",
      requestedBy: actor,
    })
    .returning();
  // Fire-and-forget: assemble the bundle asynchronously (R10.4 NC-1).
  void processExport(request, actor);
  res.status(202).json(GetCustomerExportResponse.parse(serializeDsar(request)));
});

router.get(
  "/customers/:id/export/:requestId",
  async (req, res): Promise<void> => {
    const customerId = Number(req.params.id);
    const requestId = Number(req.params.requestId);
    if (!Number.isInteger(customerId) || !Number.isInteger(requestId)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const [request] = await db
      .select()
      .from(dsarRequestsTable)
      .where(
        and(
          eq(dsarRequestsTable.id, requestId),
          eq(dsarRequestsTable.customerId, customerId),
          eq(dsarRequestsTable.dealerId, activeDealerId(res)),
        ),
      );
    if (!request) {
      res.status(404).json({ error: "DSAR request not found" });
      return;
    }
    res.json(GetCustomerExportResponse.parse(serializeDsar(request)));
  },
);

router.post(
  "/customers/:id/erase",
  idempotent("customers.erase"),
  async (req, res): Promise<void> => {
    const params = GetCustomerParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const user = res.locals.user;
    // Erasure is destructive: customers ADMIN category required (not create).
    if (!user || !hasPermission(user, "customers", "admin")) {
      res.status(403).json({
        error: "forbidden",
        message: "Erasure requires customers admin permission",
      });
      return;
    }
    const dealerId = activeDealerId(res);
    const [customer] = await db
      .select({ id: customersTable.id, erasedAt: customersTable.erasedAt })
      .from(customersTable)
      .where(
        and(
          eq(customersTable.id, params.data.id),
          eq(customersTable.dealerId, dealerId),
        ),
      );
    if (!customer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const actor = user.name ?? user.email ?? "unknown";
    // R10.5 legal holds defer erasure: 422 unmet[] + a blocked dsar row.
    const unmet = await erasureHolds(dealerId, customer.id);
    if (unmet.length > 0) {
      const [blocked] = await db
        .insert(dsarRequestsTable)
        .values({
          dealerId,
          customerId: customer.id,
          kind: "erase",
          status: "blocked",
          requestedBy: actor,
          unmet,
        })
        .returning();
      res.status(422).json({
        error: "legal_hold",
        unmet,
        request: serializeDsar(blocked),
      });
      return;
    }
    const [request] = await db
      .insert(dsarRequestsTable)
      .values({
        dealerId,
        customerId: customer.id,
        kind: "erase",
        status: "processing",
        requestedBy: actor,
      })
      .returning();
    void runErasureSaga(request, actor);
    res
      .status(202)
      .json(EraseCustomerDataResponse.parse(serializeDsar(request)));
  },
);

function serializeDsar(r: DsarRequestRow): Record<string, unknown> {
  return {
    ...r,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
  };
}

export default router;
