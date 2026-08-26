/**
 * Meta Lead Ads polling fallback.
 *
 * Webhooks are the primary delivery path, but Meta silently withholds
 * leadgen webhooks in several real-world states (app in Development Mode,
 * Lead Access Manager restrictions, transient delivery disablement after
 * repeated callback failures). This sweep polls each connected page's
 * ACTIVE lead forms for recent leads and pushes any unseen leadgen ids
 * through the exact same intake path as the webhook
 * (processLeadgenEvent), which is idempotent via the webhook_events
 * ledger — so webhook + poll can never double-create a lead.
 *
 * SERVER-ONLY.
 */
import { isNotNull } from "drizzle-orm";
import { db, dealersTable } from "@workspace/db";
import { resolveMetaPageToken } from "./meta-connection";
import { processLeadgenEvent } from "../routes/webhooks";
import { logger } from "./logger";

const GRAPH_BASE =
  process.env["META_GRAPH_BASE_URL"] || "https://graph.facebook.com/v21.0";

const POLL_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes
const LOOKBACK_SECONDS = 48 * 3600; // catch anything webhooks missed recently

type GraphList<T> = { data?: T[]; paging?: { next?: string }; error?: unknown };

async function graphGet<T>(url: string): Promise<GraphList<T>> {
  const resp = await fetch(url);
  const body = (await resp.json()) as GraphList<T>;
  if (!resp.ok || body.error) {
    throw new Error(
      `Graph API ${resp.status}: ${JSON.stringify(body.error ?? {}).slice(0, 300)}`,
    );
  }
  return body;
}

async function pollDealerPage(
  dealerId: number,
  pageId: string,
): Promise<void> {
  const token = await resolveMetaPageToken(dealerId);
  if (!token) {
    // A mapped page with no usable token means this dealer's intake is dead;
    // surface it every sweep so it can't rot silently.
    logger.warn(
      { dealerId, pageId },
      "Meta lead poll: dealer has a mapped page but no usable page token",
    );
    return;
  }

  // Bounded cursor pagination: enough for any realistic 48h backlog while
  // keeping one sweep's Graph usage capped. Anything beyond the cap is picked
  // up by the next sweep (the lookback window overlaps).
  const MAX_PAGES = 5;
  const collect = async <T,>(firstUrl: string): Promise<T[]> => {
    const out: T[] = [];
    let url: string | undefined = firstUrl;
    for (let i = 0; i < MAX_PAGES && url; i++) {
      const page: GraphList<T> = await graphGet<T>(url);
      out.push(...(page.data ?? []));
      url = page.paging?.next;
    }
    return out;
  };

  const forms = await collect<{ id: string; status?: string }>(
    `${GRAPH_BASE}/${encodeURIComponent(pageId)}/leadgen_forms?fields=id,status&limit=100&access_token=${encodeURIComponent(token)}`,
  );

  const since = Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS;
  for (const form of forms) {
    if (form.status !== "ACTIVE") continue;
    const filtering = encodeURIComponent(
      JSON.stringify([
        { field: "time_created", operator: "GREATER_THAN", value: since },
      ]),
    );
    const leads = await collect<{ id: string }>(
      `${GRAPH_BASE}/${encodeURIComponent(form.id)}/leads?fields=id&limit=100&filtering=${filtering}&access_token=${encodeURIComponent(token)}`,
    );
    for (const lead of leads) {
      try {
        // Idempotent: processLeadgenEvent atomically claims the leadgen id in
        // the webhook_events ledger, so webhook + poll can never double-create.
        await processLeadgenEvent(lead.id, pageId);
      } catch (err) {
        logger.error(
          { err, dealerId, leadgenId: lead.id },
          "Meta lead poll: failed to process lead",
        );
      }
    }
  }
}

async function sweepMetaLeads(): Promise<void> {
  const dealers = await db
    .select({ id: dealersTable.id, metaPageId: dealersTable.metaPageId })
    .from(dealersTable)
    .where(isNotNull(dealersTable.metaPageId));
  for (const dealer of dealers) {
    if (!dealer.metaPageId) continue;
    try {
      await pollDealerPage(dealer.id, dealer.metaPageId);
    } catch (err) {
      logger.error(
        { err, dealerId: dealer.id },
        "Meta lead poll: dealer sweep failed",
      );
    }
  }
}

export function startMetaLeadPolling(): void {
  const timer = setInterval(() => {
    sweepMetaLeads().catch((err) =>
      logger.error({ err }, "Meta lead poll: sweep crashed"),
    );
  }, POLL_INTERVAL_MS);
  timer.unref();
  // First run shortly after boot so a restart doesn't delay pickup 10 min.
  const kickoff = setTimeout(() => {
    sweepMetaLeads().catch((err) =>
      logger.error({ err }, "Meta lead poll: initial sweep crashed"),
    );
  }, 15 * 1000);
  kickoff.unref();
  logger.info("Meta lead polling fallback started (10-minute interval)");
}
