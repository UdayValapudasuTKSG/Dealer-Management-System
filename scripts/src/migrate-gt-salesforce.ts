/**
 * One-time (re-runnable) migration of a GT Automotive Salesforce export
 * (GTP_Records_Export_*.xlsx) into the AURA DMS.
 *
 * Stages:
 *   1. Vehicles   — Vehicle + Asset + Product2 + VehicleDefinition + PricebookEntry
 *                   → vehicles (upsert by dealer + VIN; GYD prices converted to USD)
 *   2. Customers  — PersonAccount + Account + Contact → customers + contacts
 *   3. Leads      — Lead → leads (phase/source mapped, round-robin assignment)
 *
 * Safety:
 *   - Dry-run by default; --execute writes everything inside ONE transaction
 *     (a mid-run failure rolls back completely — no half-imported data).
 *   - Idempotent: vehicles upsert by (dealer, VIN); customers dedupe by
 *     email → phone (name only for business accounts); leads dedupe by
 *     email+name and phone+name.
 *   - Execute mode ABORTS if the dealer has no active sales staff (leads
 *     must be round-robin assigned); pass --allow-unassigned to override.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run migrate-gt-salesforce -- <path-to-xlsx>            # dry run (report only)
 *   pnpm --filter @workspace/scripts run migrate-gt-salesforce -- <path-to-xlsx> --execute  # write to DB
 *   Optional: --dealer <id>          target dealer (default 1 = GT Automotive)
 *             --allow-unassigned     proceed even if no sales staff exist
 *
 * In production, run with the production DATABASE_URL set.
 */
import { readFileSync, writeFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { db } from "@workspace/db";
import {
  vehiclesTable,
  customersTable,
  contactsTable,
  leadsTable,
  leadSourcesTable,
  dealersTable,
  divisionsTable,
  assetsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";

/** Works for both the root db handle and a transaction handle. */
type DbHandle = Pick<typeof db, "select" | "insert" | "update" | "execute">;

// ---------------------------------------------------------------- CLI args
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const allowUnassigned = args.includes("--allow-unassigned");
const dealerFlag = args.indexOf("--dealer");
const DEALER_ID = dealerFlag >= 0 ? Number(args[dealerFlag + 1]) : 1;
const filePath = args.find((a) => a.endsWith(".xlsx"));
if (!filePath) {
  console.error(
    "Usage: migrate-gt-salesforce -- <path-to-xlsx> [--execute] [--dealer <id>] [--allow-unassigned]",
  );
  process.exit(1);
}

type Row = Record<string, string>;

function sheetRows(wb: XLSX.WorkBook, name: string): Row[] {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json<Row>(ws, { raw: false, defval: "" });
}

// ---------------------------------------------------------------- helpers
const TEST_NAME_PATTERNS = [
  /^display\b/i,
  /^test\b/i,
  /\btest$/i,
  /\(sample\)/i,
  /^dummy\b/i,
];
const isTestName = (name: string) =>
  !name.trim() || TEST_NAME_PATTERNS.some((p) => p.test(name.trim()));

const normVin = (v: string) => v.replace(/\s+/g, "").toUpperCase();
const isValidVin = (v: string) => v.length === 17 && !/XXXX/.test(v);

const cleanPhone = (p: string) => p.replace(/[^\d+]/g, "");
const phoneKey = (p: string) => cleanPhone(p).replace(/^\+?592/, "").slice(-7);
const emailKey = (e: string) => e.trim().toLowerCase();

function parseDate(v: string): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const PHASE_MAP: Record<string, string> = {
  New: "new",
  Contacted: "contacted",
  Engaged: "qualified",
  Converted: "won",
  "Order Confirmed": "won",
};

const SOCIAL_PLATFORM_CODES = new Set([
  "facebook",
  "instagram",
  "tiktok",
  "youtube",
  "whatsapp",
]);

/** Map a Salesforce LeadSource (+ social platform) to an AURA source code. */
function mapSource(
  sfSource: string,
  platform: string,
): { source: string; sourceDetail: string | null } {
  switch (sfSource) {
    case "Website":
      return { source: "website", sourceDetail: null };
    case "Walk-in":
      return { source: "walk_in", sourceDetail: null };
    case "Referral":
      return { source: "referral", sourceDetail: null };
    case "Campaign":
      return { source: "campaign", sourceDetail: null };
    case "Social Media": {
      const p = platform.trim().toLowerCase();
      if (SOCIAL_PLATFORM_CODES.has(p)) return { source: p, sourceDetail: p };
      return { source: "facebook", sourceDetail: p || "other" };
    }
    default:
      return { source: "website", sourceDetail: null };
  }
}

interface Report {
  imported: number;
  updated: number;
  skipped: { reason: string; ref: string }[];
}
const newReport = (): Report => ({ imported: 0, updated: 0, skipped: [] });
const reports: Record<string, Report> = {
  vehicles: newReport(),
  customers: newReport(),
  contacts: newReport(),
  leads: newReport(),
  assets: newReport(),
};

// ---------------------------------------------------------------- main
async function main() {
  console.log(
    `migrate-gt-salesforce: file=${filePath} dealer=${DEALER_ID} mode=${execute ? "EXECUTE" : "DRY-RUN"}`,
  );

  const wb = XLSX.read(readFileSync(filePath!), { type: "buffer" });

  const [dealer] = await db
    .select()
    .from(dealersTable)
    .where(eq(dealersTable.id, DEALER_ID));
  if (!dealer) throw new Error(`Dealer ${DEALER_ID} not found`);
  const fx = 1; // GYD-only: imported prices are already GYD

  // Default division: only assume GT for dealer 1; otherwise use the
  // dealer's sole division, or leave null (ambiguous — don't guess).
  const divisions = await db
    .select()
    .from(divisionsTable)
    .where(eq(divisionsTable.dealerId, DEALER_ID));
  const defaultDivisionId =
    DEALER_ID === 1
      ? (divisions.find((d) => d.code === "GT")?.id ?? null)
      : divisions.length === 1
        ? divisions[0].id
        : null;

  // Round-robin pool: the dealer's active sales staff.
  const staff = await db.execute(sql`
    SELECT u.id, u.name, u.email
    FROM dealer_users du
    JOIN users u ON u.id = du.user_id AND u.status = 'active'
    JOIN roles r ON r.id = du.role_id
    WHERE du.dealer_id = ${DEALER_ID} AND r.name ILIKE '%sales%'
    ORDER BY u.id
  `);
  const salesPool = staff.rows as {
    id: number;
    name: string | null;
    email: string | null;
  }[];
  if (salesPool.length === 0) {
    if (execute && !allowUnassigned) {
      console.error(
        "ABORT: no active sales staff found for this dealer — leads cannot be " +
          "round-robin assigned. Add sales staff first, or re-run with --allow-unassigned.",
      );
      process.exit(1);
    }
    console.warn(
      "WARNING: no active sales staff — leads will be left unassigned.",
    );
  } else {
    console.log(
      `Round-robin pool: ${salesPool.map((s) => s.name ?? s.email).join(", ")}`,
    );
  }
  let rr = 0;
  const nextAssignee = () =>
    salesPool.length ? salesPool[rr++ % salesPool.length] : null;

  // Salesforce advisor mapping: Advisor__c/OwnerId → Advisor_Name (learned
  // from rows where both are present), then Advisor_Name → AURA user (by
  // exact name, exact email, or first-name email prefix e.g. "Eion Narine"
  // → eion@…). Round-robin is only the fallback when no advisor resolves.
  const sfAdvisorName = new Map<string, string>();
  for (const sheet of ["Lead", "Opportunity"]) {
    for (const r of sheetRows(wb, sheet)) {
      if (r.Advisor__c && r.Advisor_Name)
        sfAdvisorName.set(r.Advisor__c, r.Advisor_Name);
    }
  }
  const norm = (s: string) => s.trim().toLowerCase();
  const advisorUser = (advName: string) =>
    salesPool.find(
      (u) =>
        norm(u.name ?? "") === norm(advName) ||
        norm(u.email ?? "") === norm(advName) ||
        (u.email ?? "").toLowerCase().startsWith(norm(advName.split(" ")[0]) + "@"),
    ) ?? null;
  /** Resolve a Lead row's Salesforce advisor to an AURA user, or null. */
  const sfAssignee = (r: Row) => {
    const advName =
      r.Advisor_Name ||
      sfAdvisorName.get(r.Advisor__c ?? "") ||
      sfAdvisorName.get(r.OwnerId ?? "");
    return advName ? advisorUser(advName) : null;
  };

  // ------------------------------------------------ pre-load existing rows
  const existingVehicles = await db
    .select({ id: vehiclesTable.id, vin: vehiclesTable.vin })
    .from(vehiclesTable)
    .where(eq(vehiclesTable.dealerId, DEALER_ID));
  const vinToId = new Map(
    existingVehicles.filter((v) => v.vin).map((v) => [v.vin as string, v.id]),
  );

  const existingCustomers = await db
    .select({
      id: customersTable.id,
      name: customersTable.name,
      email: customersTable.email,
      phone: customersTable.phone,
      accountType: customersTable.accountType,
      tags: customersTable.tags,
    })
    .from(customersTable)
    .where(eq(customersTable.dealerId, DEALER_ID));
  const custByEmail = new Map<string, number>();
  const custByPhone = new Map<string, number>();
  const businessByName = new Map<string, number>();
  // Primary idempotency key: the Salesforce record id, stored as an
  // `sf:<Id>` tag on the customer. Survives re-runs even for records with
  // no email/phone (which identity-field dedupe cannot catch).
  const custBySfId = new Map<string, number>();
  for (const c of existingCustomers) {
    if (c.email) custByEmail.set(emailKey(c.email), c.id);
    if (c.phone && phoneKey(c.phone)) custByPhone.set(phoneKey(c.phone), c.id);
    if (c.accountType === "business")
      businessByName.set(c.name.trim().toLowerCase(), c.id);
    for (const t of c.tags ?? [])
      if (t.startsWith("sf:")) custBySfId.set(t.slice(3), c.id);
  }

  const existingLeads = await db
    .select({
      email: leadsTable.email,
      phone: leadsTable.phone,
      name: leadsTable.name,
    })
    .from(leadsTable)
    .where(eq(leadsTable.dealerId, DEALER_ID));
  const leadKeys = new Set<string>();
  const addLeadKeys = (email: string, phone: string, name: string) => {
    const n = name.trim().toLowerCase();
    if (emailKey(email)) leadKeys.add(`e:${emailKey(email)}|${n}`);
    if (phoneKey(phone)) leadKeys.add(`p:${phoneKey(phone)}|${n}`);
  };
  const hasLead = (email: string, phone: string, name: string) => {
    const n = name.trim().toLowerCase();
    return (
      (emailKey(email) !== "" && leadKeys.has(`e:${emailKey(email)}|${n}`)) ||
      (phoneKey(phone) !== "" && leadKeys.has(`p:${phoneKey(phone)}|${n}`))
    );
  };
  for (const l of existingLeads) addLeadKeys(l.email ?? "", l.phone ?? "", l.name);

  // ------------------------------------------------ import (one transaction)
  const doImport = async (dbc: DbHandle) => {
    // -------------------------------------------- Stage 1: vehicles
    const products = new Map(sheetRows(wb, "Product2").map((r) => [r.Id, r]));
    const prices = new Map(
      sheetRows(wb, "PricebookEntry").map((r) => [r.Product2Id, r]),
    );
    const defs = new Map(
      sheetRows(wb, "VehicleDefinition").map((r) => [r.Id, r]),
    );
    const assets = new Map(sheetRows(wb, "Asset").map((r) => [r.Id, r]));

    for (const v of sheetRows(wb, "Vehicle")) {
      const ref = `${v.Name} (${v.VehicleIdentificationNumber})`;
      if (v.IsDeleted === "true") {
        reports.vehicles.skipped.push({ reason: "deleted in Salesforce", ref });
        continue;
      }
      const vin = normVin(v.VehicleIdentificationNumber || "");
      const engine = normVin(v.EngineNumber || "");
      if (!isValidVin(vin)) {
        reports.vehicles.skipped.push({
          reason: "invalid/placeholder VIN",
          ref,
        });
        continue;
      }
      const status = (v.Status || "").toLowerCase() === "sold" ? "sold" : "available";

      const asset = v.AssetId ? assets.get(v.AssetId) : undefined;
      const def = v.VehicleDefinitionId
        ? defs.get(v.VehicleDefinitionId)
        : undefined;
      const product =
        (asset?.Product2Id && products.get(asset.Product2Id)) ||
        (def?.ProductId && products.get(def.ProductId)) ||
        undefined;
      const price = product ? prices.get(product.Id) : undefined;

      const make = product?.MakeName || "BYD";
      const model = product?.ModelName || def?.ModelCode || v.Name || "Unknown";
      const year = Number(product?.ModelYear) || new Date().getFullYear();
      const variant = def?.VariantName || product?.Description || null;
      const gyd = Number(price?.UnitPrice || asset?.Price || 0);
      const usd = gyd > 0 ? Math.round((gyd / fx) * 100) / 100 : 0;
      const isHybrid = /dm-i/i.test(model) || /dm-i/i.test(variant ?? "");
      const exteriorColor = v.ExteriorColor || def?.Exterior_Color__c || "Unknown";

      const existingId = vinToId.get(vin);
      if (execute) {
        if (existingId) {
          // Reconcile descriptive fields on re-run, but never touch `status`
          // — the AURA booking/deal lifecycle owns it once imported.
          await dbc
            .update(vehiclesTable)
            .set({
              make,
              model,
              year,
              variant,
              exteriorColor,
              engineNumber: isValidVin(engine) ? engine : undefined,
              price: usd > 0 ? usd : undefined,
            })
            .where(eq(vehiclesTable.id, existingId));
        } else {
          const [row] = await dbc
            .insert(vehiclesTable)
            .values({
              dealerId: DEALER_ID,
              divisionId: defaultDivisionId,
              make,
              model,
              year,
              vin,
              engineNumber: isValidVin(engine) ? engine : null,
              variant,
              price: usd,
              powertrain: isHybrid ? "Hybrid" : "EV",
              mileageKm: 0,
              exteriorColor,
              bodyType: "SUV",
              status,
              description: `Imported from Salesforce (${v.Id})`,
            })
            .returning({ id: vehiclesTable.id });
          vinToId.set(vin, row.id);
        }
      } else if (!existingId) {
        vinToId.set(vin, -1); // count would-be inserts in dry-run
      }
      existingId ? reports.vehicles.updated++ : reports.vehicles.imported++;
    }

    // -------------------------------------------- Stage 2: customers
    const contactsByAccount = new Map<string, Row[]>();
    for (const c of sheetRows(wb, "Contact")) {
      if (!contactsByAccount.has(c.AccountId))
        contactsByAccount.set(c.AccountId, []);
      contactsByAccount.get(c.AccountId)!.push(c);
    }

    const importAccount = async (r: Row, accountType: "person" | "business") => {
      const name = (r.Name || "").trim();
      const ref = `${name} (${r.Id})`;
      if (r.IsDeleted === "true" || isTestName(name)) {
        reports.customers.skipped.push({
          reason: "test/sample or deleted",
          ref,
        });
        return;
      }
      const contacts = contactsByAccount.get(r.Id) ?? [];
      const primaryContact = contacts[0];
      const email = emailKey(primaryContact?.Email || "");
      const phone = cleanPhone(
        r.Phone || primaryContact?.Phone || primaryContact?.MobilePhone || "",
      );

      // Dedupe by identity fields only (email, then phone). Name-only
      // matching is allowed just for business accounts — two different
      // PEOPLE can share a name, two businesses with the same name at the
      // same dealer are the same account.
      const dupId =
        custBySfId.get(r.Id) ??
        (email ? custByEmail.get(email) : undefined) ??
        (phoneKey(phone) ? custByPhone.get(phoneKey(phone)) : undefined) ??
        (accountType === "business"
          ? businessByName.get(name.toLowerCase())
          : undefined);
      if (dupId) {
        sfAccountToCustomerId.set(r.Id, dupId);
        reports.customers.skipped.push({
          reason: "duplicate (already exists)",
          ref,
        });
        return;
      }

      const address = [r.BillingStreet, r.BillingCity, r.BillingState]
        .filter(Boolean)
        .join(", ");
      let customerId = -1;
      if (execute) {
        const [row] = await dbc
          .insert(customersTable)
          .values({
            dealerId: DEALER_ID,
            accountType,
            name,
            email: email || null,
            phone: phone || null,
            address: address || null,
            city: r.BillingCity || null,
            country:
              r.BillingCountry || (accountType === "person" ? "Guyana" : null),
            company: accountType === "business" ? name : null,
            tags: ["salesforce-import", `sf:${r.Id}`],
            createdAt: parseDate(r.CreatedDate) ?? new Date(),
          })
          .returning({ id: customersTable.id });
        customerId = row.id;

        for (let i = 0; i < contacts.length; i++) {
          const c = contacts[i];
          const cname = (c.Name || `${c.FirstName} ${c.LastName}`).trim();
          if (!cname) continue;
          await dbc.insert(contactsTable).values({
            dealerId: DEALER_ID,
            accountId: customerId,
            name: cname,
            title: c.Title || null,
            email: c.Email || null,
            phone: cleanPhone(c.Phone || c.MobilePhone || "") || null,
            isPrimary: i === 0,
          });
          reports.contacts.imported++;
        }
        if (contacts.length === 0) {
          // Ensure a primary contact exists (sold-stage gate requires one).
          await dbc.insert(contactsTable).values({
            dealerId: DEALER_ID,
            accountId: customerId,
            name,
            email: email || null,
            phone: phone || null,
            isPrimary: true,
          });
          reports.contacts.imported++;
        }
      } else {
        reports.contacts.imported += Math.max(contacts.length, 1);
      }
      sfAccountToCustomerId.set(r.Id, customerId);
      custBySfId.set(r.Id, customerId);
      if (email) custByEmail.set(email, customerId);
      if (phoneKey(phone)) custByPhone.set(phoneKey(phone), customerId);
      if (accountType === "business")
        businessByName.set(name.toLowerCase(), customerId);
      reports.customers.imported++;
    };

    const sfAccountToCustomerId = new Map<string, number>();
    for (const r of sheetRows(wb, "PersonAccount"))
      await importAccount(r, "person");
    for (const r of sheetRows(wb, "Account"))
      await importAccount(r, "business");

    // -------------------------------------------- Stage 3: leads
    // Ensure mapped lead-source codes exist in dealer config.
    const requiredSources = [
      { code: "website", name: "Website", isSocial: false },
      { code: "walk_in", name: "Walk-in", isSocial: false },
      { code: "referral", name: "Referral", isSocial: false },
      { code: "campaign", name: "Campaign", isSocial: false },
      { code: "facebook", name: "Facebook", isSocial: true },
      { code: "instagram", name: "Instagram", isSocial: true },
      { code: "tiktok", name: "TikTok", isSocial: true },
      { code: "youtube", name: "YouTube", isSocial: true },
      { code: "whatsapp", name: "WhatsApp", isSocial: true },
    ];
    if (execute) {
      for (const s of requiredSources) {
        await dbc
          .insert(leadSourcesTable)
          .values({ dealerId: DEALER_ID, ...s })
          .onConflictDoNothing();
      }
    }

    const pendingLeads: (typeof leadsTable.$inferInsert)[] = [];
    for (const r of sheetRows(wb, "Lead")) {
      const name = (r.Name || `${r.FirstName} ${r.LastName}`).trim();
      const ref = `${name} <${r.Email}> (${r.Id})`;
      if (r.IsDeleted === "true" || isTestName(name)) {
        reports.leads.skipped.push({ reason: "test or deleted", ref });
        continue;
      }
      const phone = cleanPhone(r.Phone || "");
      if (hasLead(r.Email || "", phone, name)) {
        reports.leads.skipped.push({
          reason: "duplicate (already exists)",
          ref,
        });
        continue;
      }
      addLeadKeys(r.Email || "", phone, name);

      const phase = PHASE_MAP[r.Status] ?? "new";
      const { source, sourceDetail } = mapSource(
        r.LeadSource || "",
        r.Social_Media_Platform__c || "",
      );
      const assignee = sfAssignee(r) ?? nextAssignee();
      // Link to the customer created/found in Stage 2 (converted leads),
      // matched by email first, then phone.
      const customerId =
        custByEmail.get(emailKey(r.Email || "")) ??
        (phoneKey(phone) ? custByPhone.get(phoneKey(phone)) : undefined) ??
        null;
      const address = [r.Street, r.City, r.State].filter(Boolean).join(", ");
      const modelInterest = [r.Vehicle_Model__c, r.Vehicle_Version__c]
        .filter(Boolean)
        .join(" ");

      if (execute) {
        pendingLeads.push({
          dealerId: DEALER_ID,
          divisionId: defaultDivisionId,
          name,
          email: r.Email || null,
          phone: phone || null,
          channel:
            source === "walk_in"
              ? "walkin"
              : SOCIAL_PLATFORM_CODES.has(source)
                ? "social"
                : "web",
          source,
          sourceDetail,
          phase,
          // Valid status enum: new/assigned/contacted/qualified/…/converted.
          status:
            phase === "won"
              ? "converted"
              : phase === "qualified"
                ? "qualified"
                : phase === "contacted"
                  ? "contacted"
                  : "new",
          customerId: customerId && customerId > 0 ? customerId : null,
          variant: modelInterest || null,
          color: r.Vehicle_Color__c || null,
          assignedTo: assignee?.name ?? assignee?.email ?? null,
          ownerUserId: assignee?.id ?? null,
          testDriveAt: parseDate(r.Test_Drive_Scheduled_Date__c),
          company:
            r.Company && r.Company !== "[NOT PROVIDED]" ? r.Company : null,
          title: r.Title || null,
          quotationSent: r.Quotation_Sent__c === "true",
          reservationFeePaid: r.Reservation_Fee_Paid__c === "Yes",
          financingQualified: r.Financing_Qualified__c === "true",
          contactedDate: parseDate(r.Contacted_Date__c),
          revisitIn3Months: r.Revisit_Lead_in_3_Months__c === "true",
          closureReason: r.Reason_for_Lead_Closure__c || null,
          purchaseIntent: r.Purchase_Intent__c || null,
          keyInterestDriver: r.Key_Interest_Driver__c || null,
          budgetFinancing: r.Budget_Financing__c || null,
          description: r.Description || null,
          address: address || null,
          notes: modelInterest
            ? `Interested model (from Salesforce): ${modelInterest}${r.Vehicle_Color__c ? ` — ${r.Vehicle_Color__c}` : ""}`
            : null,
          isRetailCustomer: r.Is_Retail_Customer__c === "true",
          createdAt: parseDate(r.CreatedDate) ?? new Date(),
          stageEnteredAt:
            parseDate(r.LastModifiedDate) ?? parseDate(r.CreatedDate),
        });
      }
      reports.leads.imported++;
    }

    // Batched insert — one round trip per 500 leads instead of one per lead
    // (essential when running against a remote/production database).
    for (let i = 0; i < pendingLeads.length; i += 500) {
      await dbc.insert(leadsTable).values(pendingLeads.slice(i, i + 500));
    }

    // -------------------------------------------- Stage 3.5: interested model
    // The UI's "Interested model" reads leads.interested_vehicle_id (FK to a
    // vehicle), not the free-text variant. Backfill it by mapping the
    // Salesforce model text to an imported vehicle (color match preferred).
    if (execute) {
      await dbc.execute(sql`
        WITH mapped AS (
          SELECT l.id AS lead_id, l.color,
            CASE
              WHEN l.variant ILIKE '%sealion%' THEN 'SEALION EV'
              WHEN l.variant ILIKE '%yuan pro%' THEN 'YUAN PRO'
              WHEN l.variant ILIKE '%yuan plus%' THEN 'YUAN PLUS EV'
              WHEN l.variant ILIKE '%shark%' THEN 'SHARK'
              WHEN l.variant ILIKE '%dolphin%' THEN 'Dolphin Mini'
              WHEN l.variant ILIKE '%song%' THEN 'SONG PLUS DM'
              WHEN l.variant ILIKE '%seal%' THEN 'SEAL EV'
              ELSE NULL END AS model
          FROM leads l
          WHERE l.dealer_id = ${DEALER_ID}
            AND l.interested_vehicle_id IS NULL
            AND COALESCE(l.variant, '') <> ''
        ),
        pick AS (
          SELECT m.lead_id, (
            SELECT v.id FROM vehicles v
            WHERE v.dealer_id = ${DEALER_ID} AND upper(v.model) = upper(m.model)
            ORDER BY (COALESCE(m.color,'') <> '' AND v.exterior_color ILIKE '%' || m.color || '%') DESC,
                     (v.status = 'available') DESC, v.id
            LIMIT 1) AS vehicle_id
          FROM mapped m WHERE m.model IS NOT NULL
        )
        UPDATE leads SET interested_vehicle_id = pick.vehicle_id
        FROM pick WHERE leads.id = pick.lead_id AND pick.vehicle_id IS NOT NULL
      `);
    }

    // -------------------------------------------- Stage 4: assets (ownership)
    // Salesforce Asset rows link Accounts to the vehicles they own. Import
    // them into AURA's assets table (lifetime ownership records) and backfill
    // the denormalized lifetimeValue / vehiclesOwned on customers.
    const vehicleSheetById = new Map(
      sheetRows(wb, "Vehicle").map((v) => [v.Id, v]),
    );
    const existingAssets = await dbc
      .select({
        accountId: assetsTable.accountId,
        vehicleId: assetsTable.vehicleId,
      })
      .from(assetsTable)
      .where(eq(assetsTable.dealerId, DEALER_ID));
    const assetKeys = new Set(
      existingAssets.map((a) => `${a.accountId}:${a.vehicleId}`),
    );

    for (const a of sheetRows(wb, "Asset")) {
      const ref = `${a.Name} (${a.Id})`;
      if (a.IsDeleted === "true") {
        reports.assets.skipped.push({ reason: "deleted in Salesforce", ref });
        continue;
      }
      const customerId =
        sfAccountToCustomerId.get(a.AccountId) ??
        custBySfId.get(a.AccountId) ??
        null;
      if (!customerId) {
        reports.assets.skipped.push({
          reason: "account not imported (test/deleted/unknown)",
          ref,
        });
        continue;
      }
      const sfVehicle = vehicleSheetById.get(a.VehicleId);
      const vin = normVin(sfVehicle?.VehicleIdentificationNumber || "");
      const vehicleId = isValidVin(vin) ? vinToId.get(vin) : undefined;
      if (!vehicleId) {
        reports.assets.skipped.push({
          reason: "vehicle not imported (missing/placeholder VIN)",
          ref,
        });
        continue;
      }
      if (
        customerId > 0 &&
        vehicleId > 0 &&
        assetKeys.has(`${customerId}:${vehicleId}`)
      ) {
        reports.assets.skipped.push({
          reason: "duplicate (already exists)",
          ref,
        });
        continue;
      }
      assetKeys.add(`${customerId}:${vehicleId}`);

      if (execute) {
        await dbc.insert(assetsTable).values({
          dealerId: DEALER_ID,
          accountId: customerId,
          vehicleId,
          deliveredAt:
            parseDate(a.Actual_Delivery_Date__c) ??
            parseDate(a.CreatedDate) ??
            new Date(),
          status: "active",
        });
      }
      reports.assets.imported++;
    }

    // Recompute denormalized customer rollups from the assets table.
    // Idempotent: full recompute, so re-runs always converge.
    if (execute) {
      await dbc.execute(sql`
        UPDATE customers c
        SET vehicles_owned = COALESCE(s.cnt, 0),
            lifetime_value = COALESCE(s.ltv, 0)
        FROM customers c2
        LEFT JOIN (
          SELECT a.account_id,
                 COUNT(*)::int AS cnt,
                 COALESCE(SUM(v.price), 0) AS ltv
          FROM assets a
          JOIN vehicles v ON v.id = a.vehicle_id
          WHERE a.dealer_id = ${DEALER_ID}
          GROUP BY a.account_id
        ) s ON s.account_id = c2.id
        WHERE c.id = c2.id AND c.dealer_id = ${DEALER_ID}
      `);
    }
  };

  if (execute) {
    await db.transaction(async (tx) => doImport(tx));
  } else {
    await doImport(db);
  }

  // ------------------------------------------------ Report
  console.log("\n================ MIGRATION REPORT ================");
  for (const [entity, rep] of Object.entries(reports)) {
    console.log(
      `${entity.padEnd(10)} imported=${rep.imported} updated=${rep.updated} skipped=${rep.skipped.length}`,
    );
    const byReason = new Map<string, number>();
    for (const s of rep.skipped)
      byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    for (const [reason, n] of byReason) console.log(`   - ${reason}: ${n}`);
  }
  if (!execute) {
    console.log(
      "\nDRY RUN — nothing was written. Re-run with --execute to apply.",
    );
  } else {
    console.log(
      "\nDone. Verify counts in the app (Inventory, Customers, Pipeline).",
    );
  }
  // Detailed skip list for audit.
  const detailed = Object.entries(reports).flatMap(([e, rep]) =>
    rep.skipped.map((s) => `${e}\t${s.reason}\t${s.ref}`),
  );
  if (detailed.length) {
    const out = `/tmp/gt-migration-skipped-${Date.now()}.tsv`;
    writeFileSync(out, "entity\treason\tref\n" + detailed.join("\n"));
    console.log(`Skip details written to ${out}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("migrate-gt-salesforce failed:", err);
  process.exit(1);
});
