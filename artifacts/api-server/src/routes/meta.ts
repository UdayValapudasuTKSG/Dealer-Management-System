import { Router, type IRouter } from "express";
import { and, desc, eq, ne, or } from "drizzle-orm";
import {
  db,
  dealersTable,
  leadsTable,
  metaConnectionsTable,
  webhookEventsTable,
} from "@workspace/db";
import {
  GetMetaSettingsResponse,
  UpdateMetaSettingsBody,
  UpdateMetaSettingsResponse,
  TestMetaConnectionResponse,
  SubscribeMetaPageResponse,
} from "@workspace/api-zod";
import { activeDealerId } from "../middlewares/rbac";
import { encryptMetaSecret } from "../lib/meta-crypto";
import {
  getMetaConnectionRow,
  resolveMetaPageToken,
} from "../lib/meta-connection";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const GRAPH_BASE =
  process.env["META_GRAPH_BASE_URL"] || "https://graph.facebook.com/v21.0";

/** Permissions Lead Ads intake needs — baked into a token at generation. */
const REQUIRED_META_SCOPES = [
  "leads_retrieval",
  "pages_manage_ads",
  "pages_manage_metadata",
  "pages_show_list",
  "pages_read_engagement",
] as const;

// ---------------------------------------------------------------------------
// Settings → Meta Lead Ads (dealer-scoped, fully self-serve). Reads require
// the settings module (global authorize middleware); writes are GM-only
// (mirroring ERPNext/WhatsApp/branding). Page token + app secret are stored
// encrypted and NEVER returned; the verify token is GM-readable because the
// GM must paste it into the Meta App dashboard. Env credentials remain a
// platform-level fallback. Platform view stays in routes/platform.ts.
// ---------------------------------------------------------------------------

/** GM of the ACTIVE dealership (or super admin) — same rule as ERPNext. */
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

const META_KEYS = [
  "META_APP_SECRET",
  "META_PAGE_ACCESS_TOKEN",
  "META_VERIFY_TOKEN",
] as const;

async function settingsPayload(
  dealerId: number,
  requestHost: string | undefined,
  showVerifyToken: boolean,
) {
  const missing = META_KEYS.filter((k) => !process.env[k]);
  const domain =
    process.env["REPLIT_DOMAINS"]?.split(",")[0]?.trim() ||
    process.env["REPLIT_DEV_DOMAIN"] ||
    requestHost ||
    "";

  const [dealer] = await db
    .select({ metaPageId: dealersTable.metaPageId })
    .from(dealersTable)
    .where(eq(dealersTable.id, dealerId));

  const conn = await getMetaConnectionRow(dealerId);
  const hasPageToken =
    Boolean(conn?.pageAccessTokenCiphertext) ||
    Boolean(process.env["META_PAGE_ACCESS_TOKEN"]);
  const hasAppSecret =
    Boolean(conn?.appSecretCiphertext) || Boolean(process.env["META_APP_SECRET"]);
  const hasVerifyToken =
    Boolean(conn?.verifyToken) || Boolean(process.env["META_VERIFY_TOKEN"]);

  // Most recent Meta campaign lead for THIS dealership. Older ledger rows
  // predate dealer stamping, so fall back to the joined lead's dealer.
  const [last] = await db
    .select({
      externalId: webhookEventsTable.externalId,
      leadId: webhookEventsTable.leadId,
      createdAt: webhookEventsTable.createdAt,
      leadName: leadsTable.name,
      leadSource: leadsTable.source,
    })
    .from(webhookEventsTable)
    .leftJoin(leadsTable, eq(webhookEventsTable.leadId, leadsTable.id))
    .where(
      and(
        eq(webhookEventsTable.channel, "meta_leadgen"),
        or(
          eq(webhookEventsTable.dealerId, dealerId),
          eq(leadsTable.dealerId, dealerId),
        ),
      ),
    )
    .orderBy(desc(webhookEventsTable.createdAt))
    .limit(1);

  return {
    // Effective readiness for THIS dealer, considering stored + env values.
    configured: hasPageToken && hasAppSecret && hasVerifyToken,
    missing: [...missing],
    callbackUrl: `https://${domain}/api/webhooks/meta`,
    metaPageId: dealer?.metaPageId ?? null,
    hasPageAccessToken: Boolean(conn?.pageAccessTokenCiphertext),
    hasAppSecret: Boolean(conn?.appSecretCiphertext),
    verifyToken: showVerifyToken ? (conn?.verifyToken ?? null) : null,
    usingPlatformCredentials:
      !conn?.pageAccessTokenCiphertext && missing.length === 0,
    lastStatus: conn?.lastStatus ?? null,
    lastError: conn?.lastError ?? null,
    lastCheckedAt: conn?.lastCheckedAt ?? null,
    lastEvent: last
      ? {
          externalId: last.externalId,
          leadId: last.leadId,
          leadName: last.leadName,
          leadSource: last.leadSource,
          createdAt: last.createdAt,
        }
      : null,
    tokenExchange: null,
  };
}

router.get("/meta/settings", async (req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  res.json(
    GetMetaSettingsResponse.parse(
      await settingsPayload(dealerId, req.get("host"), canManageConnection(res)),
    ),
  );
});

router.put("/meta/settings", async (req, res): Promise<void> => {
  if (!canManageConnection(res)) {
    res.status(403).json({
      error: "Only the general manager can manage the Meta connection",
    });
    return;
  }
  const body = UpdateMetaSettingsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const dealerId = activeDealerId(res);

  // --- Page ID mapping (dealers.metaPageId) ---
  if (body.data.metaPageId !== undefined) {
    const metaPageId = body.data.metaPageId?.trim() || null;
    if (metaPageId !== null && !/^\d{5,20}$/.test(metaPageId)) {
      res.status(400).json({
        error:
          "Facebook Page ID must be 5-20 digits (find it under Business Suite → Settings → Pages)",
      });
      return;
    }
    if (metaPageId !== null) {
      const [conflict] = await db
        .select({ id: dealersTable.id, name: dealersTable.name })
        .from(dealersTable)
        .where(
          and(
            eq(dealersTable.metaPageId, metaPageId),
            ne(dealersTable.id, dealerId),
          ),
        );
      if (conflict) {
        res.status(409).json({
          error: `That Facebook Page is already connected to ${conflict.name}`,
        });
        return;
      }
    }
    try {
      await db
        .update(dealersTable)
        .set({ metaPageId })
        .where(eq(dealersTable.id, dealerId));
    } catch (err) {
      const code =
        (err as { code?: string }).code ??
        ((err as { cause?: { code?: string } }).cause?.code ?? null);
      if (code === "23505") {
        res.status(409).json({
          error: "That Facebook Page is already connected to another dealership",
        });
        return;
      }
      throw err;
    }
  }

  // --- Credentials (meta_connections row) ---
  const patch: Partial<typeof metaConnectionsTable.$inferInsert> = {};
  let tokenExchange: TokenExchange | null = null;
  if (body.data.pageAccessToken !== undefined) {
    const t = body.data.pageAccessToken?.trim() || null;
    if (t) {
      // Effective Page ID AFTER any mapping change above.
      const [row] = await db
        .select({ metaPageId: dealersTable.metaPageId })
        .from(dealersTable)
        .where(eq(dealersTable.id, dealerId));
      const prepared = await prepareTokenForStorage(t, row?.metaPageId ?? null);
      tokenExchange = prepared.exchange;
      patch.pageAccessTokenCiphertext = encryptMetaSecret(
        prepared.tokenToStore,
        dealerId,
      );
    } else {
      patch.pageAccessTokenCiphertext = null;
    }
  }
  if (body.data.appSecret !== undefined) {
    const s = body.data.appSecret?.trim() || null;
    patch.appSecretCiphertext = s ? encryptMetaSecret(s, dealerId) : null;
  }
  if (body.data.verifyToken !== undefined) {
    patch.verifyToken = body.data.verifyToken?.trim() || null;
  }
  if (Object.keys(patch).length > 0) {
    patch.updatedAt = new Date();
    await db
      .insert(metaConnectionsTable)
      .values({ dealerId, ...patch })
      .onConflictDoUpdate({
        target: metaConnectionsTable.dealerId,
        set: patch,
      });
  }

  res.json(
    UpdateMetaSettingsResponse.parse({
      ...(await settingsPayload(dealerId, req.get("host"), true)),
      tokenExchange,
    }),
  );
});

/**
 * Test the stored (or platform) Page access token against the Graph API:
 * reports what the token identifies as and whether it grants access to the
 * configured Page. Never returns the token.
 */
router.post("/meta/settings/test", async (req, res): Promise<void> => {
  if (!canManageConnection(res)) {
    res.status(403).json({
      error: "Only the general manager can test the Meta connection",
    });
    return;
  }
  const dealerId = activeDealerId(res);
  const result = await testMetaConnection(dealerId);
  res.json(TestMetaConnectionResponse.parse(result));
});

async function graphGet(
  path: string,
  token: string,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const sep = path.includes("?") ? "&" : "?";
  const resp = await fetch(
    `${GRAPH_BASE}/${path}${sep}access_token=${encodeURIComponent(token)}`,
  );
  const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: resp.ok, status: resp.status, json };
}

function graphErrorMessage(json: Record<string, unknown>): string {
  const err = json["error"] as { message?: string; code?: number } | undefined;
  return err?.message ?? "Graph API request failed";
}

/**
 * Inspect a token's granted scopes via /debug_token (the token debugs
 * itself). Returns which REQUIRED scopes are granted/missing, or nulls when
 * the inspection itself fails — never guesses.
 */
async function inspectTokenScopes(token: string): Promise<{
  grantedScopes: string[] | null;
  missingScopes: string[] | null;
}> {
  try {
    const dbg = await graphGet(
      `debug_token?input_token=${encodeURIComponent(token)}`,
      token,
    );
    const data = dbg.json["data"] as
      | { scopes?: unknown; granular_scopes?: unknown }
      | undefined;
    const raw = Array.isArray(data?.scopes) ? data.scopes : null;
    if (!dbg.ok || !raw) return { grantedScopes: null, missingScopes: null };
    const scopes = new Set(raw.filter((s): s is string => typeof s === "string"));
    return {
      grantedScopes: REQUIRED_META_SCOPES.filter((s) => scopes.has(s)),
      missingScopes: REQUIRED_META_SCOPES.filter((s) => !scopes.has(s)),
    };
  } catch {
    return { grantedScopes: null, missingScopes: null };
  }
}

type TokenExchange = {
  tokenType: "page" | "user" | null;
  exchanged: boolean;
  pageName: string | null;
  missingScopes: string[] | null;
  grantedScopes: string[] | null;
  error: string | null;
};

/**
 * Accept ANY pasted Facebook token: if it's a USER token and the dealer has
 * a Page configured, exchange it for that Page's token
 * (GET /<pageId>?fields=access_token) and store the Page token instead.
 * Always reports scope status; on any Graph failure the pasted token is
 * stored as-is with an explanatory message (never blocks the save).
 */
async function prepareTokenForStorage(
  pastedToken: string,
  pageId: string | null,
): Promise<{ tokenToStore: string; exchange: TokenExchange }> {
  const exchange: TokenExchange = {
    tokenType: null,
    exchanged: false,
    pageName: null,
    missingScopes: null,
    grantedScopes: null,
    error: null,
  };
  let tokenToStore = pastedToken;
  try {
    const scopeInfo = await inspectTokenScopes(pastedToken);
    exchange.grantedScopes = scopeInfo.grantedScopes;
    exchange.missingScopes = scopeInfo.missingScopes;

    const me = await graphGet("me?fields=id,name", pastedToken);
    if (!me.ok) {
      exchange.error = `Token could not be verified with Meta: ${graphErrorMessage(me.json)}`;
      return { tokenToStore, exchange };
    }
    const meId = String(me.json["id"] ?? "");
    const meName = typeof me.json["name"] === "string" ? me.json["name"] : null;

    if (pageId && meId === pageId) {
      exchange.tokenType = "page";
      exchange.pageName = meName;
      return { tokenToStore, exchange };
    }
    exchange.tokenType = "user";
    if (!pageId) {
      exchange.error =
        "This is a USER token and no Facebook Page ID is saved yet — save your Page ID, then paste the token again so it can be converted to the Page token.";
      return { tokenToStore, exchange };
    }
    const page = await graphGet(
      `${encodeURIComponent(pageId)}?fields=access_token,name`,
      pastedToken,
    );
    const pageToken = page.json["access_token"];
    if (!page.ok || typeof pageToken !== "string" || !pageToken) {
      exchange.error = `This is a USER token for "${meName ?? "unknown"}" and Meta did not return a Page token for Page ${pageId} (${graphErrorMessage(page.json)}). Regenerate the token in Graph API Explorer and tick your Page in the popup.`;
      return { tokenToStore, exchange };
    }
    tokenToStore = pageToken;
    exchange.exchanged = true;
    exchange.tokenType = "page";
    exchange.pageName =
      typeof page.json["name"] === "string" ? page.json["name"] : null;
    return { tokenToStore, exchange };
  } catch (err) {
    logger.error({ err }, "Meta token exchange failed");
    exchange.error =
      "Could not reach the Meta Graph API to verify the token; it was stored as pasted.";
    return { tokenToStore, exchange };
  }
}

type MetaTestOutcome = {
  ok: boolean;
  tokenType: string | null;
  tokenIdentity: string | null;
  pageOk: boolean;
  pageName: string | null;
  error: string | null;
  requiredScopes: string[];
  grantedScopes: string[] | null;
  missingScopes: string[] | null;
  scopesOk: boolean | null;
};

async function testMetaConnection(dealerId: number): Promise<MetaTestOutcome> {
  const [dealer] = await db
    .select({ metaPageId: dealersTable.metaPageId })
    .from(dealersTable)
    .where(eq(dealersTable.id, dealerId));
  const pageId = dealer?.metaPageId ?? null;
  const token = await resolveMetaPageToken(dealerId);

  // Scope status is independent of page reachability — report it on every
  // outcome so the UI can always show the permission checklist.
  let scopeInfo: {
    grantedScopes: string[] | null;
    missingScopes: string[] | null;
  } = { grantedScopes: null, missingScopes: null };
  if (token) scopeInfo = await inspectTokenScopes(token);
  const scopeFields = {
    requiredScopes: [...REQUIRED_META_SCOPES],
    grantedScopes: scopeInfo.grantedScopes,
    missingScopes: scopeInfo.missingScopes,
    scopesOk:
      scopeInfo.missingScopes === null
        ? null
        : scopeInfo.missingScopes.length === 0,
  };

  const finish = async (r: {
    ok: boolean;
    tokenType: string | null;
    tokenIdentity: string | null;
    pageOk: boolean;
    pageName: string | null;
    error: string | null;
  }): Promise<MetaTestOutcome> => {
    await db
      .insert(metaConnectionsTable)
      .values({
        dealerId,
        lastStatus: r.ok ? "connected" : "error",
        lastError: r.error,
        lastCheckedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: metaConnectionsTable.dealerId,
        set: {
          lastStatus: r.ok ? "connected" : "error",
          lastError: r.error,
          lastCheckedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    return { ...r, ...scopeFields };
  };

  if (!token) {
    return finish({
      ok: false,
      tokenType: null,
      tokenIdentity: null,
      pageOk: false,
      pageName: null,
      error: "No Page access token saved yet",
    });
  }

  // Who does this token identify as?
  const me = await graphGet("me?fields=id,name", token);
  if (!me.ok) {
    return finish({
      ok: false,
      tokenType: null,
      tokenIdentity: null,
      pageOk: false,
      pageName: null,
      error: graphErrorMessage(me.json),
    });
  }
  const meId = String(me.json["id"] ?? "");
  const meName = typeof me.json["name"] === "string" ? me.json["name"] : null;

  // A PAGE token identifies as the Page itself. A user token identifies as a
  // person — usable only if it can still read the configured page.
  const isPageToken = pageId !== null && meId === pageId;

  if (!pageId) {
    return finish({
      ok: false,
      tokenType: isPageToken ? "page" : "user",
      tokenIdentity: meName,
      pageOk: false,
      pageName: null,
      error: "Save your Facebook Page ID first, then test again",
    });
  }

  const page = await graphGet(`${encodeURIComponent(pageId)}?fields=id,name`, token);
  if (!page.ok) {
    return finish({
      ok: false,
      tokenType: isPageToken ? "page" : "user",
      tokenIdentity: meName,
      pageOk: false,
      pageName: null,
      error: isPageToken
        ? graphErrorMessage(page.json)
        : `This is a USER token for "${meName ?? "unknown"}" and it cannot read Page ${pageId}. Generate the token again, tick your Page in the popup, and switch the Graph Explorer dropdown to the Page token.`,
    });
  }
  const pageName =
    typeof page.json["name"] === "string" ? page.json["name"] : null;

  return finish({
    ok: isPageToken && scopeFields.scopesOk !== false,
    tokenType: isPageToken ? "page" : "user",
    tokenIdentity: meName,
    pageOk: true,
    pageName,
    error: isPageToken
      ? scopeFields.missingScopes && scopeFields.missingScopes.length > 0
        ? `Page token is missing permissions: ${scopeFields.missingScopes.join(", ")}. Regenerate the token in Graph API Explorer with these permissions ticked.`
        : null
      : `Token belongs to "${meName ?? "a user"}", not the Page. Save it again in the token field — it will be converted to the PAGE token for "${pageName ?? pageId}" automatically.`,
  });
}

/**
 * Subscribe the configured Page to this app's leadgen webhook
 * (POST /{page}/subscribed_apps). Requires a real PAGE token.
 */
router.post("/meta/settings/subscribe", async (req, res): Promise<void> => {
  if (!canManageConnection(res)) {
    res.status(403).json({
      error: "Only the general manager can manage the Meta connection",
    });
    return;
  }
  const dealerId = activeDealerId(res);
  const [dealer] = await db
    .select({ metaPageId: dealersTable.metaPageId })
    .from(dealersTable)
    .where(eq(dealersTable.id, dealerId));
  const pageId = dealer?.metaPageId ?? null;
  if (!pageId) {
    res.status(422).json({ error: "Save your Facebook Page ID first" });
    return;
  }
  const token = await resolveMetaPageToken(dealerId);
  if (!token) {
    res.status(422).json({ error: "Save a Page access token first" });
    return;
  }
  try {
    const resp = await fetch(
      `${GRAPH_BASE}/${encodeURIComponent(pageId)}/subscribed_apps`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          subscribed_fields: "leadgen",
          access_token: token,
        }),
      },
    );
    const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    if (!resp.ok || json["success"] !== true) {
      res.json(
        SubscribeMetaPageResponse.parse({
          ok: false,
          error: graphErrorMessage(json),
        }),
      );
      return;
    }
    res.json(SubscribeMetaPageResponse.parse({ ok: true, error: null }));
  } catch (err) {
    logger.error({ err, dealerId }, "Meta page subscribe failed");
    res.json(
      SubscribeMetaPageResponse.parse({
        ok: false,
        error: "Could not reach the Meta Graph API",
      }),
    );
  }
});

export default router;
