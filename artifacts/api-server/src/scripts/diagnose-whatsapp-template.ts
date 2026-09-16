/**
 * Read-only production WhatsApp template diagnostic.
 *
 * Run with NODE_ENV=production and an explicit
 * WHATSAPP_DIAGNOSTIC_DEALER_ID.  The @workspace/db connection then follows
 * its existing production selection (EXTERNAL_DATABASE_URL, then
 * DATABASE_URL).  This script performs no database writes and the Meta helper
 * below performs GET requests only. Set WHATSAPP_DIAGNOSTIC_DEV_DATABASE_URL
 * (or DEV_DATABASE_URL) to compare the stored development sender metadata;
 * the comparison reports booleans only.
 *
 * The output is intentionally safe to paste into a support ticket: it does
 * not include access tokens, ciphertexts, phone/WABA ids, message bodies, or
 * Meta's free-form error text.
 */
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  whatsappChannelsTable,
} from "@workspace/db";
import { decryptToken } from "../lib/whatsapp-crypto";
import { diagnoseWhatsappChannel } from "../lib/whatsapp";
import { SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE } from "../lib/service-appointment-whatsapp";

const dealerId = Number(process.env["WHATSAPP_DIAGNOSTIC_DEALER_ID"]);

if (process.env.NODE_ENV !== "production") {
  throw new Error(
    "Refusing to inspect a non-production database. Set NODE_ENV=production explicitly.",
  );
}
if (!Number.isSafeInteger(dealerId) || dealerId <= 0) {
  throw new Error(
    "Set WHATSAPP_DIAGNOSTIC_DEALER_ID to one positive dealer id.",
  );
}
const configuredGraphBase = process.env["WHATSAPP_GRAPH_BASE_URL"]?.trim();
if (configuredGraphBase) {
  let graphUrl: URL;
  try {
    graphUrl = new URL(configuredGraphBase);
  } catch {
    throw new Error("Refusing an invalid WhatsApp Graph API base URL");
  }
  if (
    graphUrl.protocol !== "https:" ||
    graphUrl.hostname !== "graph.facebook.com" ||
    !/^\/v\d+(?:\.\d+)?$/.test(graphUrl.pathname)
  ) {
    throw new Error(
      "Refusing a non-Meta Graph API base URL for the production diagnostic",
    );
  }
}

function publicDiagnostic(diagnostic: {
  phone: {
    ok: boolean;
    httpStatus: number | null;
    code: number | null;
    subcode: number | null;
    traceId: string | null;
    status: string | null;
    platformType: string | null;
  };
  waba: {
    ok: boolean;
    httpStatus: number | null;
    code: number | null;
    subcode: number | null;
    traceId: string | null;
    senderMembership: boolean | null;
  };
  template: {
    ok: boolean;
    httpStatus: number | null;
    code: number | null;
    subcode: number | null;
    traceId: string | null;
    templates: Array<{
      language: string | null;
      languageMatchesApproved: boolean;
      status: string | null;
      bodyMatchesApproved: boolean;
      bodyDiffCategories: string[];
      expectedParameterCount: number;
      actualParameterCount: number;
      expectedParameterOccurrences: number[];
      actualParameterOccurrences: number[];
      expectedParameterOccurrenceCount: number;
      actualParameterOccurrenceCount: number;
      bodyWithoutParametersMatchesApproved: boolean;
      bodyWithoutParametersExactMatchesApproved: boolean;
      bodyWithoutParametersDiffCategories: string[];
      parameterDifference: string;
      headerMatchesApproved: boolean;
      bodyComponentCount: number;
    }>;
  } | null;
}) {
  // diagnoseWhatsappChannel already returns only allowlisted fields. Keep
  // this final projection explicit so adding a provider field later cannot
  // accidentally widen this production script's output.
  return {
    phone: {
      ok: diagnostic.phone.ok,
      httpStatus: diagnostic.phone.httpStatus,
      code: diagnostic.phone.code,
      subcode: diagnostic.phone.subcode,
      traceId: diagnostic.phone.traceId,
      status: diagnostic.phone.status,
      platformType: diagnostic.phone.platformType,
    },
    waba: {
      ok: diagnostic.waba.ok,
      httpStatus: diagnostic.waba.httpStatus,
      code: diagnostic.waba.code,
      subcode: diagnostic.waba.subcode,
      traceId: diagnostic.waba.traceId,
      senderMembership: diagnostic.waba.senderMembership,
    },
    template: diagnostic.template
      ? {
          ok: diagnostic.template.ok,
          httpStatus: diagnostic.template.httpStatus,
          code: diagnostic.template.code,
          subcode: diagnostic.template.subcode,
          traceId: diagnostic.template.traceId,
          templates: diagnostic.template.templates.map((template) => ({
            language: template.language,
            languageMatchesApproved: template.languageMatchesApproved,
            status: template.status,
            bodyMatchesApproved: template.bodyMatchesApproved,
            bodyDiffCategories: template.bodyDiffCategories,
            expectedParameterCount: template.expectedParameterCount,
            actualParameterCount: template.actualParameterCount,
            expectedParameterOccurrences: template.expectedParameterOccurrences,
            actualParameterOccurrences: template.actualParameterOccurrences,
            expectedParameterOccurrenceCount:
              template.expectedParameterOccurrenceCount,
            actualParameterOccurrenceCount:
              template.actualParameterOccurrenceCount,
            bodyWithoutParametersMatchesApproved:
              template.bodyWithoutParametersMatchesApproved,
            bodyWithoutParametersExactMatchesApproved:
              template.bodyWithoutParametersExactMatchesApproved,
            bodyWithoutParametersDiffCategories:
              template.bodyWithoutParametersDiffCategories,
            parameterDifference: template.parameterDifference,
            headerMatchesApproved: template.headerMatchesApproved,
            bodyComponentCount: template.bodyComponentCount,
          })),
        }
      : null,
  };
}

type StoredChannelSummary = {
  configured: boolean;
  enabled: boolean | null;
  hasAccessToken: boolean | null;
  phoneNumberId: string | null;
  wabaId: string | null;
};

type ReadOnlyPool = {
  query<T extends Record<string, unknown>>(
    statement: string,
    values: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  end(): Promise<void>;
};

async function readDevelopmentChannel(
  targetDealerId: number,
): Promise<{ requested: boolean; accessible: boolean; channel: StoredChannelSummary | null }> {
  const databaseUrl =
    process.env["WHATSAPP_DIAGNOSTIC_DEV_DATABASE_URL"] ??
    process.env["DEV_DATABASE_URL"];
  if (!databaseUrl) {
    return { requested: false, accessible: false, channel: null };
  }
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      return { requested: true, accessible: false, channel: null };
    }
  } catch {
    return { requested: true, accessible: false, channel: null };
  }

  // Reuse the pg Pool constructor already loaded by @workspace/db so the
  // diagnostic script does not need a second database dependency. This pool
  // executes one parameterized SELECT and is closed before returning.
  const PoolConstructor = pool.constructor as unknown as new (options: {
    connectionString: string;
    max: number;
    connectionTimeoutMillis: number;
  }) => ReadOnlyPool;
  const devPool = new PoolConstructor({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  try {
    const result = await devPool.query<{
      dealer_id: number;
      waba_id: string;
      phone_number_id: string;
      enabled: boolean;
      has_access_token: boolean;
    }>(
      `select dealer_id, waba_id, phone_number_id, enabled,
              (access_token_ciphertext is not null) as has_access_token
         from whatsapp_channels
        where dealer_id = $1
        limit 1`,
      [targetDealerId],
    );
    const row = result.rows[0];
    return {
      requested: true,
      accessible: true,
      channel: row
        ? {
            configured: true,
            enabled: row.enabled,
            hasAccessToken: row.has_access_token,
            phoneNumberId: row.phone_number_id,
            wabaId: row.waba_id,
          }
        : {
            configured: false,
            enabled: null,
            hasAccessToken: null,
            phoneNumberId: null,
            wabaId: null,
          },
    };
  } catch {
    return { requested: true, accessible: false, channel: null };
  } finally {
    await devPool.end();
  }
}

function compareStoredChannelSenders(
  production: {
    configured: boolean;
    enabled: boolean | null;
    phoneNumberId: string | null;
    wabaId: string | null;
  } | null,
  development: Awaited<ReturnType<typeof readDevelopmentChannel>>,
) {
  const dev = development.channel;
  return {
    requested: development.requested,
    accessible: development.accessible,
    configured: dev?.configured ?? null,
    senderMatches:
      production?.phoneNumberId && dev?.phoneNumberId
        ? production.phoneNumberId === dev.phoneNumberId
        : null,
    wabaMatches:
      production?.wabaId && dev?.wabaId
        ? production.wabaId === dev.wabaId
        : null,
    enabledMatches:
      production?.enabled != null && dev?.enabled != null
        ? production.enabled === dev.enabled
        : null,
  };
}

try {
  const [channel] = await db
    .select({
      dealerId: whatsappChannelsTable.dealerId,
      wabaId: whatsappChannelsTable.wabaId,
      phoneNumberId: whatsappChannelsTable.phoneNumberId,
      accessTokenCiphertext: whatsappChannelsTable.accessTokenCiphertext,
      enabled: whatsappChannelsTable.enabled,
    })
    .from(whatsappChannelsTable)
    .where(eq(whatsappChannelsTable.dealerId, dealerId))
    .limit(1);
  const development = await readDevelopmentChannel(dealerId);

  if (!channel) {
    console.log(
      JSON.stringify(
        {
          configured: false,
          dealerId,
          reason: "No WhatsApp channel row exists for this dealership",
          developmentComparison: compareStoredChannelSenders(null, development),
        },
        null,
        2,
      ),
    );
  } else if (!channel.accessTokenCiphertext) {
    console.log(
      JSON.stringify(
        {
          configured: true,
          dealerId,
          enabled: channel.enabled,
          diagnostic: null,
          reason: "The dealership channel has no encrypted access token",
          developmentComparison: compareStoredChannelSenders(
            {
              configured: true,
              enabled: channel.enabled,
              phoneNumberId: channel.phoneNumberId,
              wabaId: channel.wabaId,
            },
            development,
          ),
        },
        null,
        2,
      ),
    );
  } else {
    let accessToken: string;
    try {
      accessToken = decryptToken(channel.accessTokenCiphertext, dealerId);
    } catch {
      throw new Error("Unable to decrypt the dealership WhatsApp token");
    }

    const diagnostic = await diagnoseWhatsappChannel({
      accessToken,
      phoneNumberId: channel.phoneNumberId,
      wabaId: channel.wabaId,
      templateName: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.name,
      approvedTemplateLanguage: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.language,
      approvedTemplateBody: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.body,
      approvedTemplateHeader: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.header,
      approvedTemplateParameterCount: 8,
    });

    console.log(
      JSON.stringify(
        {
          configured: true,
          dealerId,
          enabled: channel.enabled,
          diagnostic: publicDiagnostic(diagnostic),
          developmentComparison: compareStoredChannelSenders(
            {
              configured: true,
              enabled: channel.enabled,
              phoneNumberId: channel.phoneNumberId,
              wabaId: channel.wabaId,
            },
            development,
          ),
        },
        null,
        2,
      ),
    );
  }
} finally {
  await pool.end();
}
