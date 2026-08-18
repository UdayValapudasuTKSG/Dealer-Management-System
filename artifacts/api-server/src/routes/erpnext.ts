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
  RetryErpnextSyncJobParams,
  RetryErpnextSyncJobResponse,
  BackfillErpnextResponse,
} from "@workspace/api-zod";
import { activeDealerId } from "../middlewares/rbac";
import {
  getErpnextConnection,
  upsertErpnextConnection,
  rotateWebhookSecret,
  testErpnextConnection,
  maskApiKey,
} from "../lib/erpnext/connection";
import { retryErpnextSyncJob } from "../lib/erpnext/sync";
import { backfillErpnextParts } from "../lib/erpnext/parts-sync";

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
  };
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
  try {
    await upsertErpnextConnection(dealerId, body.data);
  } catch (err) {
    const status =
      (err as { statusCode?: number }).statusCode ?? 500;
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

// ————— Backfill —————

// Push all existing parts, suppliers and open POs to ERPNext. Items are
// matched by SKU in the handlers, so re-running never duplicates documents.
router.post("/erpnext/backfill", async (_req, res): Promise<void> => {
  if (!canManageConnection(res)) {
    res.status(403).json({ error: "Only the general manager can run an ERPNext backfill" });
    return;
  }
  const dealerId = activeDealerId(res);
  const conn = await getErpnextConnection(dealerId);
  if (!conn) {
    res.status(422).json({ error: "Connect ERPNext before running a backfill" });
    return;
  }
  const counts = await backfillErpnextParts(dealerId);
  res.json(BackfillErpnextResponse.parse(counts));
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
