import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, erpnextSyncJobsTable } from "@workspace/db";
import {
  GetErpnextSettingsResponse,
  UpdateErpnextSettingsBody,
  UpdateErpnextSettingsResponse,
  TestErpnextConnectionResponse,
  RotateErpnextWebhookSecretResponse,
  ListErpnextSyncJobsResponse,
  BackfillErpnextResponse,
  RetryErpnextSyncJobParams,
  RetryErpnextSyncJobResponse,
} from "@workspace/api-zod";
import { activeDealerId } from "../middlewares/rbac";
import {
  getErpnextConnection,
  upsertErpnextConnection,
  rotateWebhookSecret,
  testErpnextConnection,
  maskApiKey,
  clientFor,
} from "../lib/erpnext/connection";
import { ErpnextError } from "../lib/erpnext/client";
import { retryErpnextSyncJob } from "../lib/erpnext/sync";
import { backfillErpnextParts } from "../lib/erpnext/parts-sync";
import { backfillErpnext } from "../lib/erpnext/entities";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Settings → ERPNext. Reads require the settings module (enforced by the
// global authorize middleware); credential writes are restricted to the
// dealership's GM (mirroring the branding rules) or a super admin.
// ---------------------------------------------------------------------------

/** GM of the ACTIVE dealership (or super admin) — same rule as branding. */
function canManageConnection(res: Parameters<typeof activeDealerId>[0]): boolean {
  const user = res.locals.user;
  const dealerId = activeDealerId(res);
  const membership = user?.dealers.find((d) => d.dealerId === dealerId);
  return (
    user?.isSuperAdmin === true ||
    membership?.isGeneralManager === true ||
    membership?.roleName === "General Manager"
  );
}

async function settingsPayload(dealerId: number, showSecret: boolean) {
  const conn = await getErpnextConnection(dealerId);
  if (!conn) {
    return {
      configured: false,
      enabled: false,
      siteUrl: null,
      apiKeyMasked: null,
      hasApiSecret: false,
      webhookSecret: null,
      webhookPath: null,
      lastStatus: null,
      lastError: null,
      lastCheckedAt: null,
      companyName: null,
      erpnextVersion: null,
      defaultWarehouse: null,
      incomeAccount: null,
      taxAccount: null,
      paymentModes: null,
      receivableAccount: null,
      settlementAccount: null,
    };
  }
  return {
    configured: true,
    enabled: conn.enabled,
    siteUrl: conn.siteUrl,
    apiKeyMasked: maskApiKey(conn.apiKey),
    hasApiSecret: true,
    // The webhook shared secret is not an ERPNext credential — the GM must
    // paste it into ERPNext's webhook config, so managers may read it.
    webhookSecret: showSecret ? conn.webhookSecret : null,
    webhookPath: `/api/webhooks/erpnext/${dealerId}`,
    lastStatus: conn.lastStatus,
    lastError: conn.lastError,
    lastCheckedAt: conn.lastCheckedAt,
    companyName: conn.companyName,
    erpnextVersion: conn.erpnextVersion,
    defaultWarehouse: conn.defaultWarehouse,
    incomeAccount: conn.incomeAccount,
    taxAccount: conn.taxAccount,
    paymentModes: conn.paymentModes,
    receivableAccount: conn.receivableAccount,
    settlementAccount: conn.settlementAccount,
  };
}

/** Best-effort existence check for mapped ERPNext accounts / modes of
 * payment: a definite "not found" rejects the save; an unreachable ERPNext
 * does not block configuration (the sync log surfaces bad mappings later). */
async function validateMapping(
  dealerId: number,
  input: {
    incomeAccount?: string | null;
    taxAccount?: string | null;
    paymentModes?: Record<string, string> | null;
    receivableAccount?: string | null;
    settlementAccount?: string | null;
  },
): Promise<string | null> {
  const conn = await getErpnextConnection(dealerId);
  if (!conn) return null;
  const client = clientFor(conn);
  const checks: Array<{ doctype: string; name: string; label: string }> = [];
  if (input.incomeAccount?.trim()) {
    checks.push({ doctype: "Account", name: input.incomeAccount.trim(), label: "Income account" });
  }
  if (input.taxAccount?.trim()) {
    checks.push({ doctype: "Account", name: input.taxAccount.trim(), label: "Tax account" });
  }
  if (input.receivableAccount?.trim()) {
    checks.push({ doctype: "Account", name: input.receivableAccount.trim(), label: "Receivable account" });
  }
  if (input.settlementAccount?.trim()) {
    checks.push({ doctype: "Account", name: input.settlementAccount.trim(), label: "Settlement account" });
  }
  for (const [method, mode] of Object.entries(input.paymentModes ?? {})) {
    if (mode?.trim()) {
      checks.push({
        doctype: "Mode of Payment",
        name: mode.trim(),
        label: `Mode of payment for "${method.replace(/_/g, " ")}"`,
      });
    }
  }
  for (const check of checks) {
    try {
      await client.getDoc(check.doctype, check.name);
    } catch (err) {
      if (err instanceof ErpnextError && err.kind === "not_found") {
        return `${check.label} "${check.name}" does not exist in ERPNext — create it there first or fix the spelling`;
      }
      // Unreachable / auth problems: don't block the save on validation.
      return null;
    }
  }
  return null;
}

router.get("/erpnext/settings", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  res.json(
    GetErpnextSettingsResponse.parse(
      await settingsPayload(dealerId, canManageConnection(res)),
    ),
  );
});

router.put("/erpnext/settings", async (req, res): Promise<void> => {
  if (!canManageConnection(res)) {
    res.status(403).json({ error: "Only the general manager can manage the ERPNext connection" });
    return;
  }
  const body = UpdateErpnextSettingsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  if (
    body.data.incomeAccount !== undefined ||
    body.data.taxAccount !== undefined ||
    body.data.paymentModes !== undefined ||
    body.data.receivableAccount !== undefined ||
    body.data.settlementAccount !== undefined
  ) {
    const problem = await validateMapping(dealerId, body.data);
    if (problem) {
      res.status(422).json({ error: problem });
      return;
    }
  }
  try {
    await upsertErpnextConnection(dealerId, body.data);
  } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : "Failed to save connection",
    });
    return;
  }
  res.json(
    UpdateErpnextSettingsResponse.parse(await settingsPayload(dealerId, true)),
  );
});

router.post("/erpnext/settings/test", async (_req, res): Promise<void> => {
  if (!canManageConnection(res)) {
    res.status(403).json({ error: "Only the general manager can test the ERPNext connection" });
    return;
  }
  const result = await testErpnextConnection(activeDealerId(res));
  res.json(TestErpnextConnectionResponse.parse(result));
});

router.post(
  "/erpnext/settings/rotate-webhook-secret",
  async (_req, res): Promise<void> => {
    if (!canManageConnection(res)) {
      res.status(403).json({ error: "Only the general manager can rotate the webhook secret" });
      return;
    }
    try {
      const webhookSecret = await rotateWebhookSecret(activeDealerId(res));
      res.json(RotateErpnextWebhookSecretResponse.parse({ webhookSecret }));
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(status).json({
        error: err instanceof Error ? err.message : "Failed to rotate secret",
      });
    }
  },
);

// ————— Backfill: sync records that existed before the integration —————

// Pushes existing customers, invoices and payments (matched/deduped by the
// entity handlers) AND parts, suppliers and open POs (matched by SKU) to
// ERPNext. Re-running never duplicates documents.
router.post("/erpnext/backfill", async (_req, res): Promise<void> => {
  if (!canManageConnection(res)) {
    res.status(403).json({ error: "Only the general manager can run a backfill" });
    return;
  }
  const dealerId = activeDealerId(res);
  const conn = await getErpnextConnection(dealerId);

  if (!conn) {
    res.status(404).json({ error: "Connect ERPNext before running a backfill" });
    return;
  }
  const entityCounts = await backfillErpnext(dealerId);
  const partsCounts = await backfillErpnextParts(dealerId);
  res.json(BackfillErpnextResponse.parse({ ...entityCounts, ...partsCounts }));
});

// ————— Sync activity log —————

router.get("/erpnext/sync-jobs", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const rows = await db
    .select()
    .from(erpnextSyncJobsTable)
    .where(eq(erpnextSyncJobsTable.dealerId, dealerId))
    .orderBy(desc(erpnextSyncJobsTable.createdAt))
    .limit(50);
  res.json(ListErpnextSyncJobsResponse.parse(rows));
});

router.post("/erpnext/sync-jobs/:id/retry", async (req, res): Promise<void> => {
  const params = RetryErpnextSyncJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const job = await retryErpnextSyncJob(activeDealerId(res), params.data.id);
  if (!job) {
    res.status(404).json({ error: "Sync job not found or not in a retryable state" });
    return;
  }
  res.json(RetryErpnextSyncJobResponse.parse(job));
});

export default router;
