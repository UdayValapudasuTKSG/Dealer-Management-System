import { Router, type IRouter, type Response } from "express";
import { and, desc, eq, ne } from "drizzle-orm";
import {
  db,
  amberDevicesTable,
  amberEventsTable,
  amberVehicleStatesTable,
  vehiclesTable,
  auditLogsTable,
} from "@workspace/db";
import {
  GetAmberSettingsResponse,
  UpdateAmberSettingsBody,
  UpdateAmberSettingsResponse,
  TestAmberConnectionResponse,
  RotateAmberWebhookSecretResponse,
  ListAmberDevicesResponse,
  RegisterAmberDeviceBody,
  RegisterAmberDeviceResponse,
  MapAmberDeviceParams,
  MapAmberDeviceBody,
  MapAmberDeviceResponse,
  UnmapAmberDeviceParams,
  UnmapAmberDeviceResponse,
  ListAmberFleetStateResponse,
  ListAmberEventsResponse,
  GetAmberVehicleStatusParams,
  GetAmberVehicleStatusResponse,
} from "@workspace/api-zod";
import { activeDealerId, hasPermission } from "../middlewares/rbac";
import {
  getAmberConnection,
  upsertAmberConnection,
  rotateAmberWebhookSecret,
  testAmberConnection,
} from "../lib/amber/connection";
import { resolveAmberProvider } from "../lib/amber/provider";
import { acquireAmberDeviceLock } from "../lib/amber/ingest";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Amber Connect module routes. The whole /amber segment is gated by:
//   1. RBAC — the "amber" permission module (authorize middleware), and
//   2. the "amber_connect" dealer entitlement (DEFAULT OFF; missing = 404).
// Credential writes are restricted to the dealership's GM or a super admin.
// Secrets are never returned to the browser (hint + presence only).
// ---------------------------------------------------------------------------

/** GM of the ACTIVE dealership (or super admin) — same rule as ERPNext. */
function canManageConnection(res: Response): boolean {
  const user = res.locals.user;
  const dealerId = activeDealerId(res);
  const membership = user?.dealers.find((d) => d.dealerId === dealerId);
  return (
    user?.isSuperAdmin === true ||
    membership?.isGeneralManager === true ||
    membership?.roleName === "General Manager"
  );
}

/** Location visibility is restricted: GM/super-admin or amber:admin only. */
function canSeeLocation(res: Response): boolean {
  const user = res.locals.user;
  if (!user) return false;
  return canManageConnection(res) || hasPermission(user, "amber", "admin");
}

async function amberAudit(
  res: Response,
  entry: {
    action: "create" | "update" | "delete";
    entityType: string;
    entityId: string | number;
    summary: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  const user = res.locals.user;
  await db
    .insert(auditLogsTable)
    .values({
      dealerId: activeDealerId(res),
      actorUserId: user?.id ?? null,
      actorClerkId: user?.clerkId ?? null,
      actorName: user?.name ?? null,
      actorEmail: user?.email ?? null,
      action: entry.action,
      module: "amber",
      entityType: entry.entityType,
      entityId: String(entry.entityId),
      summary: entry.summary,
      details: entry.details ?? null,
    })
    .catch((err) => logger.error({ err }, "Failed to write amber audit row"));
}

async function settingsPayload(dealerId: number, showSecret: boolean) {
  const conn = await getAmberConnection(dealerId);
  if (!conn) {
    return {
      configured: false,
      enabled: false,
      apiBaseUrl: null,
      apiKeyHint: null,
      hasApiKey: false,
      contractStatus: "pending_documentation" as const,
      webhookSecret: null,
      webhookPath: null,
      lastStatus: null,
      lastError: null,
      lastCheckedAt: null,
      lastSyncStatus: null,
      lastSyncAt: null,
    };
  }
  return {
    configured: true,
    enabled: conn.enabled,
    apiBaseUrl: conn.apiBaseUrl,
    apiKeyHint: conn.apiKeyHint,
    hasApiKey: !!conn.apiKeyCiphertext,
    // "configured" only once a verified provider adapter is active.
    contractStatus: resolveAmberProvider(conn)
      ? ("configured" as const)
      : ("pending_documentation" as const),
    // Webhook shared secret: the GM must configure it on the sender side,
    // so managers may read it (same reasoning as the ERPNext secret).
    webhookSecret: showSecret ? conn.webhookSecret : null,
    webhookPath: `/api/webhooks/amber/${dealerId}`,
    lastStatus: conn.lastStatus,
    lastError: conn.lastError,
    lastCheckedAt: conn.lastCheckedAt,
    lastSyncStatus: conn.lastSyncStatus,
    lastSyncAt: conn.lastSyncAt,
  };
}

router.get("/amber/settings", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  res.json(
    GetAmberSettingsResponse.parse(
      await settingsPayload(dealerId, canManageConnection(res)),
    ),
  );
});

router.put("/amber/settings", async (req, res): Promise<void> => {
  if (!canManageConnection(res)) {
    res.status(403).json({
      error: "Only the General Manager can manage the Amber connection",
    });
    return;
  }
  const body = UpdateAmberSettingsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  try {
    await upsertAmberConnection(dealerId, body.data);
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    res.status(statusCode).json({
      error: err instanceof Error ? err.message : "Failed to save settings",
    });
    return;
  }
  await amberAudit(res, {
    action: "update",
    entityType: "amber_connection",
    entityId: dealerId,
    summary: `${res.locals.user?.name ?? "Admin"} updated the Amber Connect connection settings`,
    details: {
      enabled: body.data.enabled ?? null,
      apiBaseUrlChanged: body.data.apiBaseUrl !== undefined,
      apiKeyChanged: body.data.apiKey !== undefined,
    },
  });
  res.json(
    UpdateAmberSettingsResponse.parse(await settingsPayload(dealerId, true)),
  );
});

router.post("/amber/settings/test", async (_req, res): Promise<void> => {
  if (!canManageConnection(res)) {
    res.status(403).json({
      error: "Only the General Manager can test the Amber connection",
    });
    return;
  }
  try {
    const result = await testAmberConnection(activeDealerId(res));
    res.json(TestAmberConnectionResponse.parse(result));
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    res.status(statusCode).json({
      error: err instanceof Error ? err.message : "Test failed",
    });
  }
});

router.post(
  "/amber/settings/rotate-webhook-secret",
  async (_req, res): Promise<void> => {
    if (!canManageConnection(res)) {
      res.status(403).json({
        error: "Only the General Manager can rotate the webhook secret",
      });
      return;
    }
    const dealerId = activeDealerId(res);
    try {
      const webhookSecret = await rotateAmberWebhookSecret(dealerId);
      await amberAudit(res, {
        action: "update",
        entityType: "amber_connection",
        entityId: dealerId,
        summary: `${res.locals.user?.name ?? "Admin"} rotated the Amber webhook shared secret`,
      });
      res.json(RotateAmberWebhookSecretResponse.parse({ webhookSecret }));
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(statusCode).json({
        error: err instanceof Error ? err.message : "Rotation failed",
      });
    }
  },
);

// ---------------------------------------------------------------------------
// Devices & vehicle mapping
// ---------------------------------------------------------------------------

async function devicePayload(dealerId: number) {
  const rows = await db
    .select({
      device: amberDevicesTable,
      vehicleVin: vehiclesTable.vin,
      make: vehiclesTable.make,
      model: vehiclesTable.model,
      year: vehiclesTable.year,
    })
    .from(amberDevicesTable)
    .leftJoin(
      vehiclesTable,
      and(
        eq(amberDevicesTable.vehicleId, vehiclesTable.id),
        eq(vehiclesTable.dealerId, dealerId),
      ),
    )
    .where(eq(amberDevicesTable.dealerId, dealerId))
    .orderBy(desc(amberDevicesTable.updatedAt));
  return rows.map(({ device, vehicleVin, make, model, year }) => ({
    id: device.id,
    deviceId: device.deviceId,
    reportedVin: device.reportedVin,
    label: device.label,
    vehicleId: device.vehicleId,
    mappingStatus: device.mappingStatus,
    conflictReason: device.conflictReason,
    mappedBy: device.mappedBy,
    mappedAt: device.mappedAt,
    lastSeenAt: device.lastSeenAt,
    vehicleLabel: make ? `${year} ${make} ${model}` : null,
    vehicleVin: vehicleVin ?? null,
  }));
}

router.get("/amber/devices", async (_req, res): Promise<void> => {
  res.json(
    ListAmberDevicesResponse.parse(await devicePayload(activeDealerId(res))),
  );
});

router.post("/amber/devices", async (req, res): Promise<void> => {
  const body = RegisterAmberDeviceBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const deviceId = body.data.deviceId.trim();
  const reportedVin = body.data.reportedVin?.trim().toUpperCase() || null;
  const [device] = await db
    .insert(amberDevicesTable)
    .values({
      dealerId,
      deviceId,
      reportedVin,
      label: body.data.label?.trim() || null,
      mappingStatus: "unmatched",
    })
    .onConflictDoUpdate({
      target: [amberDevicesTable.dealerId, amberDevicesTable.deviceId],
      set: {
        ...(body.data.reportedVin !== undefined ? { reportedVin } : {}),
        ...(body.data.label !== undefined
          ? { label: body.data.label?.trim() || null }
          : {}),
        updatedAt: new Date(),
      },
    })
    .returning();
  await amberAudit(res, {
    action: "create",
    entityType: "amber_device",
    entityId: device!.id,
    summary: `${res.locals.user?.name ?? "Admin"} registered Amber device ${deviceId}`,
    details: { deviceId, reportedVin },
  });
  const [payload] = (await devicePayload(dealerId)).filter(
    (d) => d.id === device!.id,
  );
  res.json(RegisterAmberDeviceResponse.parse(payload));
});

router.post("/amber/devices/:id/map", async (req, res): Promise<void> => {
  const params = MapAmberDeviceParams.safeParse(req.params);
  const body = MapAmberDeviceBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const dealerId = activeDealerId(res);
  const [device] = await db
    .select()
    .from(amberDevicesTable)
    .where(
      and(
        eq(amberDevicesTable.id, params.data.id),
        eq(amberDevicesTable.dealerId, dealerId),
      ),
    );
  if (!device) {
    res.status(404).json({ error: "Device not found" });
    return;
  }
  const [vehicle] = await db
    .select({
      id: vehiclesTable.id,
      vin: vehiclesTable.vin,
      make: vehiclesTable.make,
      model: vehiclesTable.model,
      year: vehiclesTable.year,
    })
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.id, body.data.vehicleId),
        eq(vehiclesTable.dealerId, dealerId),
      ),
    );
  if (!vehicle) {
    res.status(404).json({ error: "Vehicle not found" });
    return;
  }
  // Explicit VIN confirmation: the admin must type/confirm the vehicle's VIN.
  const confirm = body.data.confirmVin.trim().toUpperCase();
  if (!vehicle.vin || vehicle.vin.toUpperCase() !== confirm) {
    res.status(409).json({
      error: "VIN confirmation does not match the selected vehicle's VIN",
    });
    return;
  }
  // Conflict: another device of this dealer already mapped to the vehicle.
  const [other] = await db
    .select({ id: amberDevicesTable.id, deviceId: amberDevicesTable.deviceId })
    .from(amberDevicesTable)
    .where(
      and(
        eq(amberDevicesTable.dealerId, dealerId),
        eq(amberDevicesTable.vehicleId, vehicle.id),
        ne(amberDevicesTable.id, device.id),
      ),
    );
  if (other) {
    await db
      .update(amberDevicesTable)
      .set({
        mappingStatus: "conflict",
        conflictReason: `Vehicle already mapped to device ${other.deviceId}`,
        updatedAt: new Date(),
      })
      .where(eq(amberDevicesTable.id, device.id));
    res.status(409).json({
      error: `Vehicle is already mapped to device ${other.deviceId} — unmap it first`,
    });
    return;
  }
  try {
    // Device update + state relink commit atomically so a webhook racing this
    // mapping can never observe (or restore) a half-applied linkage.
    await db.transaction(async (tx) => {
      // Shared per-device advisory lock — serializes against event ingestion
      // (same lock order: advisory lock → state row → vehicle row).
      await acquireAmberDeviceLock(tx, dealerId, device.deviceId);
      await tx
        .update(amberDevicesTable)
        .set({
          vehicleId: vehicle.id,
          mappingStatus: "mapped",
          conflictReason: null,
          mappedBy: res.locals.user?.name ?? res.locals.user?.email ?? "admin",
          mappedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(amberDevicesTable.id, device.id));
      await tx
        .update(amberVehicleStatesTable)
        .set({ vehicleId: vehicle.id, updatedAt: new Date() })
        .where(
          and(
            eq(amberVehicleStatesTable.dealerId, dealerId),
            eq(amberVehicleStatesTable.deviceId, device.deviceId),
          ),
        );
    });
  } catch (err) {
    // Partial unique index (dealer_id, vehicle_id) enforces one active device
    // per vehicle even under concurrent mapping requests.
    const pgCode = (err as { cause?: { code?: string }; code?: string }).code ??
      (err as { cause?: { code?: string } }).cause?.code;
    if (pgCode === "23505") {
      await db
        .update(amberDevicesTable)
        .set({
          mappingStatus: "conflict",
          conflictReason: "Vehicle already mapped to another device",
          updatedAt: new Date(),
        })
        .where(eq(amberDevicesTable.id, device.id));
      res.status(409).json({
        error: "Vehicle is already mapped to another device — unmap it first",
      });
      return;
    }
    throw err;
  }
  await amberAudit(res, {
    action: "update",
    entityType: "amber_device",
    entityId: device.id,
    summary: `${res.locals.user?.name ?? "Admin"} mapped Amber device ${device.deviceId} to ${vehicle.year} ${vehicle.make} ${vehicle.model} (VIN-confirmed)`,
    details: { deviceId: device.deviceId, vehicleId: vehicle.id },
  });
  const [payload] = (await devicePayload(dealerId)).filter(
    (d) => d.id === device.id,
  );
  res.json(MapAmberDeviceResponse.parse(payload));
});

router.post("/amber/devices/:id/unmap", async (req, res): Promise<void> => {
  const params = UnmapAmberDeviceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const [device] = await db
    .select()
    .from(amberDevicesTable)
    .where(
      and(
        eq(amberDevicesTable.id, params.data.id),
        eq(amberDevicesTable.dealerId, dealerId),
      ),
    );
  if (!device) {
    res.status(404).json({ error: "Device not found" });
    return;
  }
  // Unlink device + state atomically so a webhook racing this unmap can
  // never restore the old vehicle linkage on the state row.
  await db.transaction(async (tx) => {
    // Shared per-device advisory lock — serializes against event ingestion.
    await acquireAmberDeviceLock(tx, dealerId, device.deviceId);
    await tx
      .update(amberDevicesTable)
      .set({
        vehicleId: null,
        mappingStatus: "unmatched",
        conflictReason: null,
        mappedBy: null,
        mappedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(amberDevicesTable.id, device.id));
    await tx
      .update(amberVehicleStatesTable)
      .set({ vehicleId: null, updatedAt: new Date() })
      .where(
        and(
          eq(amberVehicleStatesTable.dealerId, dealerId),
          eq(amberVehicleStatesTable.deviceId, device.deviceId),
        ),
      );
  });
  await amberAudit(res, {
    action: "update",
    entityType: "amber_device",
    entityId: device.id,
    summary: `${res.locals.user?.name ?? "Admin"} removed the vehicle mapping from Amber device ${device.deviceId}`,
  });
  const [payload] = (await devicePayload(dealerId)).filter(
    (d) => d.id === device.id,
  );
  res.json(UnmapAmberDeviceResponse.parse(payload));
});

// ---------------------------------------------------------------------------
// Fleet state, events, vehicle status
// ---------------------------------------------------------------------------

export const AMBER_STALE_AFTER_MS = 60 * 60 * 1000; // 1h → stale
export const AMBER_OFFLINE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h → offline
const AMBER_LIVE_WITHIN_MS = 5 * 60 * 1000;

export function amberFreshness(
  lastEventAt: Date | null,
): "live" | "recent" | "stale" | "offline" | "never" {
  if (!lastEventAt) return "never";
  const age = Date.now() - lastEventAt.getTime();
  if (age <= AMBER_LIVE_WITHIN_MS) return "live";
  if (age <= AMBER_STALE_AFTER_MS) return "recent";
  if (age <= AMBER_OFFLINE_AFTER_MS) return "stale";
  return "offline";
}

router.get("/amber/fleet", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const showLocation = canSeeLocation(res);
  const rows = await db
    .select({
      state: amberVehicleStatesTable,
      make: vehiclesTable.make,
      model: vehiclesTable.model,
      year: vehiclesTable.year,
    })
    .from(amberVehicleStatesTable)
    .leftJoin(
      vehiclesTable,
      and(
        eq(amberVehicleStatesTable.vehicleId, vehiclesTable.id),
        eq(vehiclesTable.dealerId, dealerId),
      ),
    )
    .where(eq(amberVehicleStatesTable.dealerId, dealerId))
    .orderBy(desc(amberVehicleStatesTable.updatedAt));
  res.json(
    ListAmberFleetStateResponse.parse(
      rows.map(({ state, make, model, year }) => ({
        id: state.id,
        deviceId: state.deviceId,
        vehicleId: state.vehicleId,
        vehicleLabel: make ? `${year} ${make} ${model}` : null,
        latitude: showLocation ? state.latitude : null,
        longitude: showLocation ? state.longitude : null,
        locationAt: state.locationAt,
        locationRestricted: !showLocation,
        odometerKm: state.odometerKm,
        odometerAt: state.odometerAt,
        ignitionOn: state.ignitionOn,
        ignitionAt: state.ignitionAt,
        deviceHealth: state.deviceHealth,
        deviceHealthAt: state.deviceHealthAt,
        lastEventAt: state.lastEventAt,
        freshness: amberFreshness(state.lastEventAt),
      })),
    ),
  );
});

router.get("/amber/events", async (req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const deviceId =
    typeof req.query["deviceId"] === "string" ? req.query["deviceId"] : null;
  const rows = await db
    .select({
      id: amberEventsTable.id,
      deviceId: amberEventsTable.deviceId,
      externalId: amberEventsTable.externalId,
      type: amberEventsTable.type,
      occurredAt: amberEventsTable.occurredAt,
      status: amberEventsTable.status,
      error: amberEventsTable.error,
      createdAt: amberEventsTable.createdAt,
    })
    .from(amberEventsTable)
    .where(
      deviceId
        ? and(
            eq(amberEventsTable.dealerId, dealerId),
            eq(amberEventsTable.deviceId, deviceId),
          )
        : eq(amberEventsTable.dealerId, dealerId),
    )
    .orderBy(desc(amberEventsTable.occurredAt))
    .limit(200);
  res.json(ListAmberEventsResponse.parse(rows));
});

router.get(
  "/amber/vehicles/:vehicleId/status",
  async (req, res): Promise<void> => {
    const params = GetAmberVehicleStatusParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const dealerId = activeDealerId(res);
    const [vehicle] = await db
      .select({ id: vehiclesTable.id })
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.id, params.data.vehicleId),
          eq(vehiclesTable.dealerId, dealerId),
        ),
      );
    if (!vehicle) {
      res.status(404).json({ error: "Vehicle not found" });
      return;
    }
    const [row] = await db
      .select()
      .from(amberVehicleStatesTable)
      .where(
        and(
          eq(amberVehicleStatesTable.dealerId, dealerId),
          eq(amberVehicleStatesTable.vehicleId, vehicle.id),
        ),
      )
      .orderBy(desc(amberVehicleStatesTable.updatedAt))
      .limit(1);
    if (!row) {
      res.json(
        GetAmberVehicleStatusResponse.parse({
          mapped: false,
          deviceId: null,
          odometerKm: null,
          odometerAt: null,
          ignitionOn: null,
          ignitionAt: null,
          deviceHealth: null,
          lastEventAt: null,
          freshness: "never",
        }),
      );
      return;
    }
    res.json(
      GetAmberVehicleStatusResponse.parse({
        mapped: true,
        deviceId: row.deviceId,
        odometerKm: row.odometerKm,
        odometerAt: row.odometerAt,
        ignitionOn: row.ignitionOn,
        ignitionAt: row.ignitionAt,
        deviceHealth: row.deviceHealth,
        lastEventAt: row.lastEventAt,
        freshness: amberFreshness(row.lastEventAt),
      }),
    );
  },
);

export default router;
