export type QuotePayloadSnapshot = Record<string, string>;

export type QuoteVersionOutboxCandidate = {
  dealerId: number;
  leadId: number | null;
  channel: string;
  template: string;
  payload: Record<string, string> | null;
};

function parseDocumentQuotePayload(
  payload: Record<string, string> | null,
): QuotePayloadSnapshot | null {
  const raw = payload?.documentDataJson;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const result: QuotePayloadSnapshot = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        result[key] = String(value);
      }
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Select the exact historical quote snapshot from an already dealer-scoped
 * outbox result set. Email rows store the snapshot directly; WhatsApp quote
 * documents store it in documentDataJson. Both lead identity and quote
 * identity must agree before a row can be replayed.
 */
export function selectQuoteVersionOutboxPayload(
  candidates: QuoteVersionOutboxCandidate[],
  expected: {
    dealerId: number;
    leadId: number;
    quoteId: number;
    quoteRef: string;
  },
): QuotePayloadSnapshot | null {
  for (const candidate of candidates) {
    if (
      candidate.dealerId !== expected.dealerId ||
      (candidate.channel === "email" && candidate.template !== "vehicle_quote") ||
      (candidate.channel !== "email" && candidate.channel !== "whatsapp")
    ) {
      continue;
    }
    const payloads =
      candidate.channel === "whatsapp"
        ? [parseDocumentQuotePayload(candidate.payload)]
        : [candidate.payload];
    for (const payload of payloads) {
      if (!payload) continue;
      if (
        (candidate.leadId != null && candidate.leadId !== expected.leadId) ||
        (candidate.leadId == null &&
          payload.leadId !== String(expected.leadId)) ||
        (payload.leadId != null &&
          payload.leadId !== String(expected.leadId))
      ) {
        continue;
      }
      const hasQuoteId = payload.quoteId != null;
      const hasQuoteRef = payload.quoteRef != null;
      const quoteIdMatches = payload.quoteId === String(expected.quoteId);
      const quoteRefMatches = payload.quoteRef === expected.quoteRef;
      if (
        (hasQuoteId && !quoteIdMatches) ||
        (hasQuoteRef && !quoteRefMatches) ||
        (!quoteIdMatches && !quoteRefMatches)
      ) {
        continue;
      }
      return { ...payload };
    }
  }
  return null;
}

/**
 * Download precedence is deliberately snapshot-first:
 *   1. queued payload (canonical or legacy replay),
 *   2. latest saved canonical quote payload,
 *   3. a legacy inventory-derived payload.
 *
 * Keeping this rule shared by the metadata and PDF endpoints prevents a
 * queued historical amount/advisor from being replaced by current inventory
 * or current ownership during replay.
 */
export function selectQuoteDownloadPayload(
  sentPayload: QuotePayloadSnapshot | null,
  canonicalPayload: QuotePayloadSnapshot | null,
  freshPayload: QuotePayloadSnapshot | null,
): QuotePayloadSnapshot | null {
  return sentPayload ?? canonicalPayload ?? freshPayload;
}