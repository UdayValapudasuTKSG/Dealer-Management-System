import { Router, type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  vehiclesTable,
  vehicleModelGlCodesTable,
  auditLogsTable,
  normalizeModelKey,
  type VehicleModelGlCode,
} from "@workspace/db";
import {
  UpsertVehicleModelGlCodeBody,
  ListVehicleModelGlCodesResponse,
  UpsertVehicleModelGlCodeResponse,
  ValidateVehicleModelGlCodesResponse,
} from "@workspace/api-zod";
import { activeDealerId } from "../middlewares/rbac";
import { getErpnextConnection, clientFor } from "../lib/erpnext/connection";
import { ErpnextError } from "../lib/erpnext/client";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Vehicle model GL codes — dealership-scoped Finance mapping of one GL
// account code per normalized make/model. All variants/VINs under the same
// normalized make/model inherit the mapping.
// ---------------------------------------------------------------------------

type InventoryModel = {
  makeKey: string;
  modelKey: string;
  make: string;
  model: string;
  count: number;
};

/** Distinct normalized make/models currently in the dealer's inventory,
 * grouped through the ONE shared normalizer (never SQL-side variants). */
async function inventoryModels(dealerId: number): Promise<InventoryModel[]> {
  const rows = await db
    .select({ make: vehiclesTable.make, model: vehiclesTable.model })
    .from(vehiclesTable)
    .where(
      and(eq(vehiclesTable.dealerId, dealerId), isNull(vehiclesTable.deletedAt)),
    );
  const byKey = new Map<string, InventoryModel>();
  for (const r of rows) {
    const makeKey = normalizeModelKey(r.make);
    const modelKey = normalizeModelKey(r.model);
    if (!makeKey || !modelKey) continue;
    const key = `${makeKey}|${modelKey}`;
    const existing = byKey.get(key);
    if (existing) existing.count += 1;
    else
      byKey.set(key, {
        makeKey,
        modelKey,
        make: r.make.trim().replace(/\s+/g, " "),
        model: r.model.trim().replace(/\s+/g, " "),
        count: 1,
      });
  }
  return [...byKey.values()].sort((a, b) =>
    a.makeKey === b.makeKey
      ? a.modelKey.localeCompare(b.modelKey)
      : a.makeKey.localeCompare(b.makeKey),
  );
}

function erpnextField(
  connected: boolean,
  mapping: VehicleModelGlCode | undefined,
): "verified" | "invalid" | "unchecked" | "not_connected" {
  if (!connected) return "not_connected";
  if (mapping?.erpnextStatus === "verified") return "verified";
  if (mapping?.erpnextStatus === "invalid") return "invalid";
  return "unchecked";
}

router.get("/vehicle-model-gl-codes", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const [models, mappings, conn] = await Promise.all([
    inventoryModels(dealerId),
    db
      .select()
      .from(vehicleModelGlCodesTable)
      .where(eq(vehicleModelGlCodesTable.dealerId, dealerId)),
    getErpnextConnection(dealerId),
  ]);
  const connected = !!conn && conn.enabled;
  const mappingByKey = new Map(
    mappings.map((m) => [`${m.makeKey}|${m.modelKey}`, m]),
  );
  const seen = new Set<string>();

  const out = models.map((m) => {
    const key = `${m.makeKey}|${m.modelKey}`;
    seen.add(key);
    const mapping = mappingByKey.get(key);
    return {
      make: m.make,
      model: m.model,
      makeKey: m.makeKey,
      modelKey: m.modelKey,
      vehicleCount: m.count,
      glCode: mapping?.glCode ?? null,
      accountName: mapping?.accountName ?? null,
      status: mapping ? ("configured" as const) : ("missing" as const),
      erpnext: erpnextField(connected, mapping),
      erpnextCheckedAt: mapping?.erpnextCheckedAt?.toISOString() ?? null,
      updatedBy: mapping?.updatedBy ?? null,
      updatedAt: mapping?.updatedAt?.toISOString() ?? null,
    };
  });
  // Orphan mappings (model no longer in inventory) stay visible so Finance
  // can see historical codes; vehicleCount 0 marks them.
  for (const m of mappings) {
    const key = `${m.makeKey}|${m.modelKey}`;
    if (seen.has(key)) continue;
    out.push({
      make: m.makeLabel,
      model: m.modelLabel,
      makeKey: m.makeKey,
      modelKey: m.modelKey,
      vehicleCount: 0,
      glCode: m.glCode,
      accountName: m.accountName ?? null,
      status: "configured" as const,
      erpnext: erpnextField(connected, m),
      erpnextCheckedAt: m.erpnextCheckedAt?.toISOString() ?? null,
      updatedBy: m.updatedBy ?? null,
      updatedAt: m.updatedAt?.toISOString() ?? null,
    });
  }

  res.json(
    ListVehicleModelGlCodesResponse.parse({
      models: out,
      erpnextConnected: connected,
    }),
  );
});

router.put("/vehicle-model-gl-codes", async (req, res): Promise<void> => {
  const parsed = UpsertVehicleModelGlCodeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const makeKey = normalizeModelKey(parsed.data.make);
  const modelKey = normalizeModelKey(parsed.data.model);
  const glCode = parsed.data.glCode.trim().replace(/\s+/g, " ");
  const accountName = parsed.data.accountName?.trim() || null;

  if (!makeKey || !modelKey) {
    res.status(400).json({ error: "Make and model must not be blank" });
    return;
  }
  if (!glCode) {
    res.status(400).json({ error: "GL code must not be blank" });
    return;
  }
  if (glCode.length > 140) {
    res.status(400).json({ error: "GL code is too long (max 140 characters)" });
    return;
  }

  // The mapping must target a model actually present in this dealership's
  // inventory (missing rows appear automatically; no free-form rows). Compare
  // through the same normalizer used everywhere else.
  const models = await inventoryModels(dealerId);
  const model = models.find(
    (m) => m.makeKey === makeKey && m.modelKey === modelKey,
  );
  const [existing] = await db
    .select()
    .from(vehicleModelGlCodesTable)
    .where(
      and(
        eq(vehicleModelGlCodesTable.dealerId, dealerId),
        eq(vehicleModelGlCodesTable.makeKey, makeKey),
        eq(vehicleModelGlCodesTable.modelKey, modelKey),
      ),
    );
  if (!model && !existing) {
    res.status(404).json({
      error: "That make/model is not in this dealership's inventory",
    });
    return;
  }

  const user = res.locals.user;
  const actor = user?.name ?? user?.email ?? null;
  const codeChanged = existing?.glCode !== glCode;

  let saved: VehicleModelGlCode;
  try {
    [saved] = await db
      .insert(vehicleModelGlCodesTable)
      .values({
        dealerId,
        makeKey,
        modelKey,
        makeLabel: model?.make ?? existing?.makeLabel ?? parsed.data.make.trim(),
        modelLabel:
          model?.model ?? existing?.modelLabel ?? parsed.data.model.trim(),
        glCode,
        accountName,
        updatedBy: actor,
      })
      .onConflictDoUpdate({
        target: [
          vehicleModelGlCodesTable.dealerId,
          vehicleModelGlCodesTable.makeKey,
          vehicleModelGlCodesTable.modelKey,
        ],
        set: {
          glCode,
          accountName,
          updatedBy: actor,
          updatedAt: new Date(),
          // A changed code invalidates any prior ERPNext verification.
          ...(codeChanged
            ? { erpnextStatus: null, erpnextCheckedAt: null }
            : {}),
        },
      })
      .returning() as [VehicleModelGlCode];
  } catch (err) {
    // Per-dealer GL-code uniqueness (23505 arrives in err.cause with drizzle).
    const pgCode =
      (err as { code?: string }).code ??
      ((err as { cause?: { code?: string } }).cause?.code ?? null);
    if (pgCode === "23505") {
      res.status(409).json({
        error: `GL code ${glCode} is already assigned to another model in this dealership`,
      });
      return;
    }
    throw err;
  }

  await db.insert(auditLogsTable).values({
    dealerId,
    actorUserId: user?.id ?? null,
    actorClerkId: user?.clerkId ?? null,
    actorName: user?.name ?? null,
    actorEmail: user?.email ?? null,
    action: existing ? "update" : "create",
    module: "finance",
    entityType: "vehicle_model_gl_code",
    entityId: `${makeKey}|${modelKey}`,
    summary: `${actor ?? "Finance user"} ${existing ? "updated" : "set"} the GL code for ${saved.makeLabel} ${saved.modelLabel} (${existing ? `${existing.glCode} → ` : ""}${glCode})`,
    details: {
      makeKey,
      modelKey,
      before: existing
        ? { glCode: existing.glCode, accountName: existing.accountName }
        : null,
      after: { glCode, accountName },
    },
  });

  const conn = await getErpnextConnection(dealerId);
  const connected = !!conn && conn.enabled;
  res.json(
    UpsertVehicleModelGlCodeResponse.parse({
      make: saved.makeLabel,
      model: saved.modelLabel,
      makeKey: saved.makeKey,
      modelKey: saved.modelKey,
      vehicleCount: model?.count ?? 0,
      glCode: saved.glCode,
      accountName: saved.accountName ?? null,
      status: "configured",
      erpnext: erpnextField(connected, saved),
      erpnextCheckedAt: saved.erpnextCheckedAt?.toISOString() ?? null,
      updatedBy: saved.updatedBy ?? null,
      updatedAt: saved.updatedAt?.toISOString() ?? null,
    }),
  );
});

/** Check whether an ERPNext Account exists for the given code — matched by
 * document name first, then by account_number. Never invents local data. */
async function accountExists(
  client: ReturnType<typeof clientFor>,
  glCode: string,
): Promise<boolean> {
  try {
    await client.getDoc("Account", glCode);
    return true;
  } catch (err) {
    if (!(err instanceof ErpnextError) || err.kind !== "not_found") throw err;
  }
  const rows = await client.listDocs<{ name: string }>("Account", {
    filters: [["Account", "account_number", "=", glCode]],
    fields: ["name"],
    limit: 1,
  });
  return rows.length > 0;
}

router.post(
  "/vehicle-model-gl-codes/validate",
  async (req, res): Promise<void> => {
    const dealerId = activeDealerId(res);
    const conn = await getErpnextConnection(dealerId);
    if (!conn || !conn.enabled) {
      res.status(400).json({
        error:
          "ERPNext is not connected for this dealership — connect it in Settings → ERPNext first",
      });
      return;
    }
    const client = clientFor(conn);
    const mappings = await db
      .select()
      .from(vehicleModelGlCodesTable)
      .where(eq(vehicleModelGlCodesTable.dealerId, dealerId));

    const results: {
      makeKey: string;
      modelKey: string;
      glCode: string;
      status: "verified" | "invalid";
      message: string | null;
    }[] = [];
    for (const m of mappings) {
      let ok: boolean;
      try {
        ok = await accountExists(client, m.glCode);
      } catch (err) {
        // Connector failure: report it, change nothing (statuses keep their
        // last-known values — never marked invalid on a network error).
        req.log.warn(
          { err, dealerId, glCode: m.glCode },
          "ERPNext account validation failed",
        );
        res.status(502).json({
          error:
            "ERPNext could not be reached while validating accounts — no statuses were changed",
        });
        return;
      }
      const status = ok ? ("verified" as const) : ("invalid" as const);
      await db
        .update(vehicleModelGlCodesTable)
        .set({
          erpnextStatus: status,
          erpnextCheckedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(vehicleModelGlCodesTable.id, m.id),
            eq(vehicleModelGlCodesTable.dealerId, dealerId),
          ),
        );
      results.push({
        makeKey: m.makeKey,
        modelKey: m.modelKey,
        glCode: m.glCode,
        status,
        message: ok
          ? null
          : "No ERPNext Account matches this code (by name or account number)",
      });
    }

    res.json(
      ValidateVehicleModelGlCodesResponse.parse({
        checked: results.length,
        verified: results.filter((r) => r.status === "verified").length,
        invalid: results.filter((r) => r.status === "invalid").length,
        results,
      }),
    );
  },
);

export default router;
