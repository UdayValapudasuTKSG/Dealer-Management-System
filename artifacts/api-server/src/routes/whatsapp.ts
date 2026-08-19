import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, whatsappChannelsTable } from "@workspace/db";
import {
  GetWhatsappSettingsResponse,
  UpdateWhatsappSettingsBody,
  UpdateWhatsappSettingsResponse,
  TestWhatsappConnectionResponse,
} from "@workspace/api-zod";
import { activeDealerId } from "../middlewares/rbac";
import { encryptToken } from "../lib/whatsapp-crypto";
import { getChannelByDealerId } from "../lib/whatsapp-channel";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// WhatsApp channel settings — dealer-scoped.
// GM/super-admin writes only (same rule as branding / ERPNext).
// GET never returns the access token — only hasAccessToken.
// ---------------------------------------------------------------------------

const GRAPH_BASE =
  process.env["WHATSAPP_GRAPH_BASE_URL"] || "https://graph.facebook.com/v21.0";

function databaseErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const error = err as {
    code?: unknown;
    cause?: { code?: unknown };
  };
  return typeof error.code === "string"
    ? error.code
    : typeof error.cause?.code === "string"
      ? error.cause.code
      : undefined;
}

function canManageWhatsapp(res: Parameters<typeof activeDealerId>[0]): boolean {
  const user = res.locals.user;
  const dealerId = activeDealerId(res);
  const membership = user?.dealers.find(
    (d: { dealerId: number }) => d.dealerId === dealerId,
  );
  return (
    user?.isSuperAdmin === true ||
    membership?.isGeneralManager === true ||
    membership?.roleName === "General Manager"
  );
}

async function settingsPayload(dealerId: number) {
  const [row] = await db
    .select()
    .from(whatsappChannelsTable)
    .where(eq(whatsappChannelsTable.dealerId, dealerId));

  if (!row) {
    const legacy = await getChannelByDealerId(dealerId);
    if (legacy) {
      return {
        configured: true,
        enabled: true,
        wabaId: legacy.wabaId || null,
        phoneNumberId: legacy.phoneNumberId,
        displayPhoneNumber: legacy.displayPhoneNumber,
        verifiedName: legacy.verifiedName,
        serviceTemplateName: legacy.serviceTemplateName,
        serviceTemplateLanguage: legacy.serviceTemplateLanguage,
        hasAccessToken: true,
        lastStatus: null,
        lastError: null,
        lastCheckedAt: null,
      };
    }
    return {
      configured: false,
      enabled: false,
      wabaId: null,
      phoneNumberId: null,
      displayPhoneNumber: null,
      verifiedName: null,
      serviceTemplateName: null,
      serviceTemplateLanguage: "en_US",
      hasAccessToken: false,
      lastStatus: null,
      lastError: null,
      lastCheckedAt: null,
    };
  }
  return {
    configured: true,
    enabled: row.enabled,
    wabaId: row.wabaId,
    phoneNumberId: row.phoneNumberId,
    displayPhoneNumber: row.displayPhoneNumber ?? null,
    verifiedName: row.verifiedName ?? null,
    serviceTemplateName: row.serviceTemplateName ?? null,
    serviceTemplateLanguage: row.serviceTemplateLanguage || "en_US",
    hasAccessToken: Boolean(row.accessTokenCiphertext),
    lastStatus: row.lastStatus ?? null,
    lastError: row.lastError ?? null,
    lastCheckedAt: row.lastCheckedAt ?? null,
  };
}

router.get("/whatsapp/settings", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  res.json(GetWhatsappSettingsResponse.parse(await settingsPayload(dealerId)));
});

router.put("/whatsapp/settings", async (req, res): Promise<void> => {
  if (!canManageWhatsapp(res)) {
    res.status(403).json({ error: "Only the general manager can manage WhatsApp settings" });
    return;
  }
  const body = UpdateWhatsappSettingsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const dealerId = activeDealerId(res);

  // Check whether this is an initial config or an update.
  const [existing] = await db
    .select({
      id: whatsappChannelsTable.id,
      wabaId: whatsappChannelsTable.wabaId,
      phoneNumberId: whatsappChannelsTable.phoneNumberId,
      ciphertext: whatsappChannelsTable.accessTokenCiphertext,
    })
    .from(whatsappChannelsTable)
    .where(eq(whatsappChannelsTable.dealerId, dealerId));

  const isInitial = !existing;
  const legacy = isInitial ? await getChannelByDealerId(dealerId) : null;
  const initialWabaId = body.data.wabaId || legacy?.wabaId || null;
  const initialPhoneNumberId =
    body.data.phoneNumberId || legacy?.phoneNumberId || null;
  const initialAccessToken = body.data.accessToken || legacy?.accessToken || null;

  // On initial config, wabaId, phoneNumberId, and accessToken are required.
  if (isInitial) {
    if (!initialWabaId || !initialPhoneNumberId || !initialAccessToken) {
      res.status(400).json({
        error: "wabaId, phoneNumberId, and accessToken are required for the initial configuration",
      });
      return;
    }
  } else if (!existing.ciphertext && !body.data.accessToken) {
    res.status(400).json({
      error: "An access token is required before this channel can be enabled",
    });
    return;
  }

  // Give a clear error before encrypting/inserting when a number belongs to
  // another dealer. The unique constraint below still protects the race.
  const phoneNumberIdToSave = isInitial
    ? initialPhoneNumberId
    : body.data.phoneNumberId;
  if (phoneNumberIdToSave) {
    const [assignedChannel] = await db
      .select({ dealerId: whatsappChannelsTable.dealerId })
      .from(whatsappChannelsTable)
      .where(eq(whatsappChannelsTable.phoneNumberId, phoneNumberIdToSave));
    if (assignedChannel && assignedChannel.dealerId !== dealerId) {
      res.status(409).json({
        error:
          "This Meta Phone Number ID is already connected to another dealership. Switch to that dealership or enter a different Phone Number ID.",
      });
      return;
    }
  }

  // Build the update set.
  const now = new Date();
  const updates: Record<string, unknown> = { updatedAt: now };

  if (body.data.wabaId !== undefined) updates["wabaId"] = body.data.wabaId;
  if (body.data.phoneNumberId !== undefined) updates["phoneNumberId"] = body.data.phoneNumberId;
  if (body.data.enabled !== undefined) updates["enabled"] = body.data.enabled;
  if (body.data.serviceTemplateName !== undefined)
    updates["serviceTemplateName"] = body.data.serviceTemplateName;
  if (body.data.serviceTemplateLanguage !== undefined)
    updates["serviceTemplateLanguage"] = body.data.serviceTemplateLanguage;

  // Encrypt the token when provided; preserve existing ciphertext when omitted.
  const accessTokenToStore = isInitial
    ? initialAccessToken
    : body.data.accessToken;
  if (accessTokenToStore) {
    try {
      updates["accessTokenCiphertext"] = encryptToken(
        accessTokenToStore,
        dealerId,
      );
    } catch (err) {
      logger.error({ dealerId, err: (err as Error).message }, "Failed to encrypt WhatsApp token");
      res.status(500).json({ error: "Failed to secure the access token" });
      return;
    }
  }

  if (
    body.data.wabaId !== undefined ||
    body.data.phoneNumberId !== undefined ||
    body.data.accessToken !== undefined
  ) {
    updates["lastStatus"] = null;
    updates["lastError"] = null;
    updates["lastCheckedAt"] = null;
  }

  try {
    if (isInitial) {
      await db.insert(whatsappChannelsTable).values({
        dealerId,
        wabaId: initialWabaId!,
        phoneNumberId: initialPhoneNumberId!,
        enabled: body.data.enabled ?? true,
        serviceTemplateName: body.data.serviceTemplateName ?? null,
        serviceTemplateLanguage: body.data.serviceTemplateLanguage ?? "en_US",
        accessTokenCiphertext: updates["accessTokenCiphertext"] as string,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await db
        .update(whatsappChannelsTable)
        .set(updates)
        .where(eq(whatsappChannelsTable.dealerId, dealerId));
    }
  } catch (err) {
    if (databaseErrorCode(err) === "23505") {
      res.status(409).json({
        error:
          "This Meta Phone Number ID is already connected to another dealership. Switch to that dealership or enter a different Phone Number ID.",
      });
      return;
    }
    logger.error(
      { dealerId, code: databaseErrorCode(err) },
      "Failed to save WhatsApp channel settings",
    );
    res.status(500).json({
      error: "Unable to save WhatsApp settings. Please try again.",
    });
    return;
  }

  res.json(UpdateWhatsappSettingsResponse.parse(await settingsPayload(dealerId)));
});

router.post("/whatsapp/settings/test", async (_req, res): Promise<void> => {
  if (!canManageWhatsapp(res)) {
    res.status(403).json({ error: "Only the general manager can test the WhatsApp connection" });
    return;
  }
  const dealerId = activeDealerId(res);
  const channel = await getChannelByDealerId(dealerId);

  if (!channel) {
    res.json(
      TestWhatsappConnectionResponse.parse({
        ok: false,
        error: "WhatsApp channel is not configured or disabled for this dealership",
        verifiedName: null,
        displayPhoneNumber: null,
        cloudApiStatus: null,
      }),
    );
    return;
  }

  try {
    const appId = process.env["META_APP_ID"];
    const appSecret = process.env["META_APP_SECRET"];
    if (!appId || !appSecret) {
      throw new Error("The platform Meta app is not fully configured");
    }
    if (!channel.wabaId) {
      throw new Error("The WhatsApp Business Account ID is missing");
    }

    // 1. Prove the token was issued to this platform's Meta app.
    const debugParams = new URLSearchParams({
      input_token: channel.accessToken,
      access_token: `${appId}|${appSecret}`,
    });
    const debugResp = await fetch(
      `${GRAPH_BASE}/debug_token?${debugParams.toString()}`,
    );
    if (!debugResp.ok) {
      throw new Error(`Meta rejected the access token (HTTP ${debugResp.status})`);
    }
    const debugData = (await debugResp.json()) as {
      data?: { app_id?: string; is_valid?: boolean };
    };
    if (
      debugData.data?.is_valid !== true ||
      String(debugData.data.app_id ?? "") !== appId
    ) {
      throw new Error(
        "The access token is not valid for this platform's Meta app",
      );
    }

    // 2. Prove the configured phone number belongs to the submitted WABA.
    const wabaResp = await fetch(
      `${GRAPH_BASE}/${encodeURIComponent(channel.wabaId)}/phone_numbers?fields=id&limit=100`,
      { headers: { Authorization: `Bearer ${channel.accessToken}` } },
    );
    if (!wabaResp.ok) {
      throw new Error(
        `Meta could not read the WhatsApp Business Account (HTTP ${wabaResp.status})`,
      );
    }
    const wabaData = (await wabaResp.json()) as {
      data?: { id?: string }[];
    };
    if (
      !wabaData.data?.some(
        (phone) => String(phone.id ?? "") === channel.phoneNumberId,
      )
    ) {
      throw new Error(
        "The Phone Number ID does not belong to this WhatsApp Business Account",
      );
    }

    // 3. Verify that the number is connected to the Cloud API.
    const phoneResp = await fetch(
      `${GRAPH_BASE}/${encodeURIComponent(channel.phoneNumberId)}?fields=verified_name,display_phone_number,quality_rating,platform_type,status`,
      {
        headers: { Authorization: `Bearer ${channel.accessToken}` },
      },
    );

    if (!phoneResp.ok) {
      logger.warn(
        { dealerId, phoneNumberId: channel.phoneNumberId, status: phoneResp.status },
        "WhatsApp phone number verification failed",
      );
      throw new Error(
        `Meta could not read the Phone Number ID (HTTP ${phoneResp.status})`,
      );
    }

    const phoneData = await phoneResp.json() as {
      verified_name?: string;
      display_phone_number?: string;
      platform_type?: string;
      status?: string;
    };

    const verifiedName = phoneData.verified_name ?? null;
    const displayPhoneNumber = phoneData.display_phone_number ?? null;
    const cloudApiStatus = phoneData.status ?? null;
    if (phoneData.platform_type?.toUpperCase() !== "CLOUD_API") {
      throw new Error("This phone number is not connected to the Cloud API");
    }
    if (cloudApiStatus?.toUpperCase() !== "CONNECTED") {
      throw new Error(
        `The WhatsApp phone number is not connected (status: ${cloudApiStatus ?? "unknown"})`,
      );
    }

    // 4. Subscribe this platform app to the WABA. This is required for inbound
    // messages, so a failure makes the connection test fail.
    const subResp = await fetch(
      `${GRAPH_BASE}/${encodeURIComponent(channel.wabaId)}/subscribed_apps`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${channel.accessToken}` },
      },
    );
    if (!subResp.ok) {
      throw new Error(
        `Meta could not subscribe the platform app to this WABA (HTTP ${subResp.status})`,
      );
    }

    // 5. Persist the safe identity and health fields. onConflictDoUpdate also
    // promotes the exact legacy environment channel into encrypted DB config.
    const now = new Date();
    await db
      .insert(whatsappChannelsTable)
      .values({
        dealerId,
        wabaId: channel.wabaId,
        phoneNumberId: channel.phoneNumberId,
        verifiedName: verifiedName ?? undefined,
        displayPhoneNumber: displayPhoneNumber ?? undefined,
        enabled: true,
        accessTokenCiphertext: encryptToken(channel.accessToken, dealerId),
        lastStatus: "connected",
        lastError: null,
        lastCheckedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: whatsappChannelsTable.dealerId,
        set: {
          verifiedName: verifiedName ?? undefined,
          displayPhoneNumber: displayPhoneNumber ?? undefined,
          lastStatus: "connected",
          lastError: null,
          lastCheckedAt: now,
          updatedAt: now,
        },
      });

    res.json(
      TestWhatsappConnectionResponse.parse({
        ok: true,
        error: null,
        verifiedName,
        displayPhoneNumber,
        cloudApiStatus,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error(
      { dealerId, err: message },
      "WhatsApp connection test failed",
    );
    // Persist the failure.
    await db
      .update(whatsappChannelsTable)
      .set({ lastStatus: "error", lastError: message, lastCheckedAt: new Date(), updatedAt: new Date() })
      .where(eq(whatsappChannelsTable.dealerId, dealerId));

    res.json(
      TestWhatsappConnectionResponse.parse({
        ok: false,
        error: message,
        verifiedName: null,
        displayPhoneNumber: null,
        cloudApiStatus: null,
      }),
    );
  }
});

export default router;
