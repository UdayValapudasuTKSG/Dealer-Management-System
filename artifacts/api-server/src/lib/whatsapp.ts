import twilio from "twilio";
import { logger } from "./logger";
import {
  SERVICE_APPOINTMENT_CONFIRMED_BODY_PARAMETER_COUNT,
  SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE,
} from "./service-appointment-whatsapp";

// ---------------------------------------------------------------------------
// Meta WhatsApp Business Platform (Cloud API) — outbound send helper.
// Sends text, document, reply-button, and interactive-list messages from the
// dealership's WhatsApp number via the Graph API.
// ---------------------------------------------------------------------------

// Overridable for local end-to-end testing against a mock Graph server.
const GRAPH_BASE =
  process.env["WHATSAPP_GRAPH_BASE_URL"] || "https://graph.facebook.com/v21.0";

export type WhatsappProvider = "meta" | "twilio";

export type WhatsappSendResult = {
  providerMessageId: string;
};

export type WhatsappSendFailureDisposition =
  | "retryable_rejection"
  | "terminal_rejection"
  | "preflight_unavailable"
  | "uncertain";

/**
 * Provider diagnostics are deliberately a small allowlist.  Meta's error
 * payload can contain request data in its message, and a recipient number is
 * not useful for diagnosing a failed send.  Keep only the fields that are
 * safe to correlate with Meta support and our outbox.
 */
export type WhatsappProviderDiagnostics = {
  httpStatus: number | null;
  code: number | null;
  subcode: number | null;
  traceId: string | null;
  correlationId: string | null;
};

function safeMetaCode(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 2_147_483_647
    ? value
    : null;
}

function safeMetaTraceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const traceId = value.trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(traceId) ? traceId : null;
}

/**
 * Correlation ids are internal outbox identifiers.  They are also sent to
 * Meta's callback-data field, so reject anything that could carry arbitrary
 * user content instead of truncating it into a log or provider request.
 */
export function safeWhatsappCorrelationId(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const correlationId = value.trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)
    ? correlationId
    : null;
}

function safeHttpStatus(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse only the documented Meta error fields.  This function intentionally
 * does not retain or return Meta's free-form error message.
 */
export function parseWhatsappProviderDiagnostics(
  body: unknown,
  httpStatus: number | null,
  correlationId?: string | null,
): WhatsappProviderDiagnostics {
  let parsed: unknown = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      parsed = null;
    }
  }
  const error = asRecord(asRecord(parsed)?.error);
  return {
    httpStatus: safeHttpStatus(httpStatus),
    code: safeMetaCode(error?.code),
    subcode: safeMetaCode(error?.error_subcode ?? error?.subcode),
    traceId: safeMetaTraceId(error?.fbtrace_id ?? error?.trace_id),
    correlationId: safeWhatsappCorrelationId(correlationId),
  };
}

const emptyWhatsappProviderDiagnostics = (
  correlationId?: string | null,
): WhatsappProviderDiagnostics =>
  parseWhatsappProviderDiagnostics(null, null, correlationId);

async function responseWhatsappProviderDiagnostics(
  response: Response,
  correlationId?: string | null,
): Promise<WhatsappProviderDiagnostics> {
  // Read the body only to extract the allowlisted fields.  Never log or put
  // the provider's raw response into an Error, outbox row, or notification.
  const body = await response.text().catch(() => "");
  return parseWhatsappProviderDiagnostics(body, response.status, correlationId);
}

type WhatsappGraphRead = {
  ok: boolean;
  diagnostics: WhatsappProviderDiagnostics;
  data: unknown;
};

async function readWhatsappGraph(
  path: string,
  accessToken: string,
): Promise<WhatsappGraphRead> {
  let response: Response;
  try {
    response = await fetch(`${GRAPH_BASE}/${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
  } catch {
    return {
      ok: false,
      diagnostics: emptyWhatsappProviderDiagnostics(),
      data: null,
    };
  }

  const body = await response.text().catch(() => "");
  let data: unknown = null;
  try {
    data = JSON.parse(body) as unknown;
  } catch {
    data = null;
  }
  return {
    ok: response.ok,
    diagnostics: parseWhatsappProviderDiagnostics(body, response.status),
    data,
  };
}

export class WhatsappProviderSendError extends Error {
  readonly diagnostics: WhatsappProviderDiagnostics;

  constructor(
    message: string,
    readonly disposition: WhatsappSendFailureDisposition,
    diagnostics?: Partial<WhatsappProviderDiagnostics>,
  ) {
    super(message);
    this.name = "WhatsappProviderSendError";
    this.diagnostics = {
      httpStatus: diagnostics?.httpStatus ?? null,
      code: diagnostics?.code ?? null,
      subcode: diagnostics?.subcode ?? null,
      traceId: diagnostics?.traceId ?? null,
      correlationId: safeWhatsappCorrelationId(diagnostics?.correlationId),
    };
  }
}

export function whatsappSendFailureDisposition(
  error: unknown,
): WhatsappSendFailureDisposition | null {
  return error instanceof WhatsappProviderSendError
    ? error.disposition
    : null;
}

export function whatsappProviderDiagnostics(
  error: unknown,
): WhatsappProviderDiagnostics | null {
  return error instanceof WhatsappProviderSendError ? error.diagnostics : null;
}

export type WhatsappReadOnlyDiagnostic = {
  httpStatus: number | null;
  code: number | null;
  subcode: number | null;
  traceId: string | null;
};

export type WhatsappTemplateDiagnostic = WhatsappReadOnlyDiagnostic & {
  language: string | null;
  languageMatchesApproved: boolean;
  status: string | null;
  bodyMatchesApproved: boolean;
  bodyDiffCategories: WhatsappTemplateBodyDiffCategory[];
  expectedParameterCount: number;
  actualParameterCount: number;
  expectedParameterOccurrences: number[];
  actualParameterOccurrences: number[];
  expectedParameterOccurrenceCount: number;
  actualParameterOccurrenceCount: number;
  bodyWithoutParametersMatchesApproved: boolean;
  bodyWithoutParametersExactMatchesApproved: boolean;
  bodyWithoutParametersDiffCategories: Array<
    "whitespace" | "punctuation" | "copy"
  >;
  parameterDifference:
    | "none"
    | "numbering_only"
    | "repeated_parameter_removed"
    | "placeholder_count_only"
    | "copy";
  headerMatchesApproved: boolean;
  bodyComponentCount: number;
};

export type WhatsappTemplateBodyDiffCategory =
  | "body_missing"
  | "body_component_count"
  | "header_missing"
  | "header_mismatch"
  | "parameter_count"
  | "parameter_order"
  | "whitespace"
  | "punctuation"
  | "copy";

export type WhatsappTemplateStructureComparison = {
  bodyMatchesApproved: boolean;
  bodyDiffCategories: WhatsappTemplateBodyDiffCategory[];
  expectedParameterCount: number;
  actualParameterCount: number;
  expectedParameterOccurrences: number[];
  actualParameterOccurrences: number[];
  expectedParameterOccurrenceCount: number;
  actualParameterOccurrenceCount: number;
  bodyWithoutParametersMatchesApproved: boolean;
  bodyWithoutParametersExactMatchesApproved: boolean;
  bodyWithoutParametersDiffCategories: Array<
    "whitespace" | "punctuation" | "copy"
  >;
  parameterDifference:
    | "none"
    | "numbering_only"
    | "repeated_parameter_removed"
    | "placeholder_count_only"
    | "copy";
  headerMatchesApproved: boolean;
  bodyComponentCount: number;
};

export type WhatsappChannelDiagnostic = {
  phone: WhatsappReadOnlyDiagnostic & {
    ok: boolean;
    status: string | null;
    platformType: string | null;
  };
  waba: WhatsappReadOnlyDiagnostic & {
    ok: boolean;
    senderMembership: boolean | null;
  };
  template: (WhatsappReadOnlyDiagnostic & {
    ok: boolean;
    templates: WhatsappTemplateDiagnostic[];
  }) | null;
};

export type WhatsappTemplateReadiness =
  | "ready"
  | "not_ready"
  | "unavailable";

function diagnosticReadWasTransientlyUnavailable(
  diagnostic: WhatsappReadOnlyDiagnostic & { ok: boolean },
): boolean {
  return (
    !diagnostic.ok &&
    (diagnostic.httpStatus == null ||
      diagnostic.httpStatus === 408 ||
      diagnostic.httpStatus === 429 ||
      diagnostic.httpStatus >= 500)
  );
}

function diagnosticHasSuccessfulRead(
  diagnostic: WhatsappReadOnlyDiagnostic & { ok: boolean },
): boolean {
  return diagnostic.ok || diagnostic.httpStatus != null;
}

function approvedWhatsappTemplateDiagnosticReady(
  diagnostic: WhatsappChannelDiagnostic,
): boolean {
  return Boolean(
    diagnostic.phone.ok &&
      diagnostic.waba.ok &&
      diagnostic.waba.senderMembership === true &&
      diagnostic.template?.ok &&
      diagnostic.template.templates.some(
        (template) =>
          template.status === "APPROVED" &&
          template.languageMatchesApproved &&
          template.bodyMatchesApproved &&
          template.headerMatchesApproved,
      ),
  );
}

/**
 * Classify the channel preflight separately from its final readiness. A
 * successful GET that finds a missing, pending, or mismatched template is a
 * durable configuration problem; a network failure or transient Graph
 * response must remain retryable and must not consume an authorized send.
 */
export function whatsappTemplateReadiness(
  diagnostic: WhatsappChannelDiagnostic,
): WhatsappTemplateReadiness {
  const reads: Array<WhatsappReadOnlyDiagnostic & { ok: boolean }> = [
    diagnostic.phone,
    diagnostic.waba,
    ...(diagnostic.template ? [diagnostic.template] : []),
  ];
  if (reads.some(diagnosticReadWasTransientlyUnavailable)) {
    return "unavailable";
  }
  if (reads.some((read) => !diagnosticHasSuccessfulRead(read))) {
    return "not_ready";
  }
  return approvedWhatsappTemplateDiagnosticReady(diagnostic)
    ? "ready"
    : "not_ready";
}

/** True only when the configured immutable template is ready for a send.
 * This consumes the diagnostic's allowlisted comparison results, not a
 * caller-provided template name, locale, or body. */
export function isApprovedWhatsappTemplateReady(
  diagnostic: WhatsappChannelDiagnostic,
): boolean {
  return whatsappTemplateReadiness(diagnostic) === "ready";
}

function templateParameterTokens(value: string): string[] {
  return [...value.matchAll(/\{\{(\d+)\}\}/g)].map((match) => match[1]!);
}

function normalizeTemplateWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function stripTemplateParameters(value: string): string {
  return value
    .replace(/\{\{\d+\}\}/g, " ")
    .replace(/\s+([,.;:!?])/gu, "$1");
}

function normalizeTemplateWithoutPunctuation(value: string): string {
  return normalizeTemplateWhitespace(value)
    .replace(/\{\{\d+\}\}/g, "{{#}}")
    .replace(/[^\p{L}\p{N}#\s]+/gu, "")
    .toLocaleLowerCase();
}

/**
 * Compare the approved service-template shape without retaining provider
 * copy. This is intentionally structural: support reports can say whether
 * punctuation, whitespace, headers, or variable counts differ without
 * printing a customer's message or the approved body.
 */
export function compareWhatsappTemplateStructure(opts: {
  body: string | null;
  header: string | null;
  bodyComponentCount: number;
  approvedBody: string;
  approvedHeader: string;
  approvedParameterCount: number;
}): WhatsappTemplateStructureComparison {
  const bodyMatchesApproved =
    opts.body !== null && opts.body === opts.approvedBody;
  const approvedParameters = templateParameterTokens(opts.approvedBody);
  const actualParameters =
    opts.body === null ? [] : templateParameterTokens(opts.body);
  const expectedParameterOccurrences = approvedParameters.map(Number);
  const actualParameterOccurrences = actualParameters.map(Number);
  const expectedParameterCount = opts.approvedParameterCount;
  const actualParameterCount = new Set(actualParameters).size;
  const expectedParameterOccurrenceCount = expectedParameterOccurrences.length;
  const actualParameterOccurrenceCount = actualParameterOccurrences.length;
  const bodyDiffCategories: WhatsappTemplateBodyDiffCategory[] = [];
  const parameterOrderMatches =
    actualParameters.join(",") === approvedParameters.join(",");
  const bodyWithoutParametersExactMatchesApproved =
    opts.body !== null &&
    stripTemplateParameters(opts.body) ===
      stripTemplateParameters(opts.approvedBody);
  const bodyWithoutParametersMatchesApproved =
    opts.body !== null &&
    normalizeTemplateWhitespace(stripTemplateParameters(opts.body)) ===
      normalizeTemplateWhitespace(stripTemplateParameters(opts.approvedBody));
  const bodyWithoutParametersDiffCategories: Array<
    "whitespace" | "punctuation" | "copy"
  > = [];
  if (!bodyWithoutParametersExactMatchesApproved && opts.body !== null) {
    const actualWithoutParameters = stripTemplateParameters(opts.body);
    const approvedWithoutParameters = stripTemplateParameters(opts.approvedBody);
    const whitespaceMatches =
      normalizeTemplateWhitespace(actualWithoutParameters) ===
      normalizeTemplateWhitespace(approvedWithoutParameters);
    const punctuationMatches =
      normalizeTemplateWithoutPunctuation(actualWithoutParameters) ===
      normalizeTemplateWithoutPunctuation(approvedWithoutParameters);
    if (whitespaceMatches) {
      bodyWithoutParametersDiffCategories.push("whitespace");
    } else if (punctuationMatches) {
      bodyWithoutParametersDiffCategories.push("punctuation");
    } else {
      bodyWithoutParametersDiffCategories.push("copy");
    }
  }
  const expectedOccurrenceCounts = new Map<number, number>();
  const actualOccurrenceCounts = new Map<number, number>();
  for (const parameter of expectedParameterOccurrences) {
    expectedOccurrenceCounts.set(
      parameter,
      (expectedOccurrenceCounts.get(parameter) ?? 0) + 1,
    );
  }
  for (const parameter of actualParameterOccurrences) {
    actualOccurrenceCounts.set(
      parameter,
      (actualOccurrenceCounts.get(parameter) ?? 0) + 1,
    );
  }
  const onlyRepeatedApprovedParameterRemoved =
    bodyWithoutParametersMatchesApproved &&
    expectedParameterOccurrenceCount > actualParameterOccurrenceCount &&
    [...expectedOccurrenceCounts.entries()].every(
      ([parameter, expectedCount]) =>
        (actualOccurrenceCounts.get(parameter) ?? 0) <= expectedCount &&
        ((actualOccurrenceCounts.get(parameter) ?? 0) === expectedCount ||
          expectedCount > 1),
    ) &&
    [...actualOccurrenceCounts.entries()].every(
      ([parameter, actualCount]) =>
        actualCount <= (expectedOccurrenceCounts.get(parameter) ?? 0),
    ) &&
    [...expectedOccurrenceCounts.entries()].some(
      ([parameter, expectedCount]) =>
        expectedCount > 1 &&
        (actualOccurrenceCounts.get(parameter) ?? 0) < expectedCount,
    );
  const parameterDifference = parameterOrderMatches
    ? "none"
    : bodyWithoutParametersMatchesApproved
      ? expectedParameterOccurrenceCount > actualParameterOccurrenceCount
        ? onlyRepeatedApprovedParameterRemoved
          ? "repeated_parameter_removed"
          : "placeholder_count_only"
        : expectedParameterOccurrenceCount === actualParameterOccurrenceCount
          ? "numbering_only"
          : "placeholder_count_only"
      : "copy";

  if (opts.bodyComponentCount !== 1) {
    bodyDiffCategories.push("body_component_count");
  }
  if (opts.header === null) {
    bodyDiffCategories.push("header_missing");
  } else if (opts.header !== opts.approvedHeader) {
    bodyDiffCategories.push("header_mismatch");
  }
  if (opts.body === null) {
    bodyDiffCategories.push("body_missing");
  } else {
    if (actualParameterCount !== expectedParameterCount) {
      bodyDiffCategories.push("parameter_count");
    }
    if (!parameterOrderMatches) {
      bodyDiffCategories.push("parameter_order");
    }
    if (!bodyMatchesApproved) {
      const whitespaceMatches =
        normalizeTemplateWhitespace(opts.body) ===
        normalizeTemplateWhitespace(opts.approvedBody);
      const punctuationMatches =
        normalizeTemplateWithoutPunctuation(opts.body) ===
        normalizeTemplateWithoutPunctuation(opts.approvedBody);
      if (!parameterOrderMatches) {
        // Report a second category only when copy remains different after
        // removing all numbered placeholders. This distinguishes a missing
        // repeated variable from an independently changed body.
        if (!bodyWithoutParametersMatchesApproved) {
          bodyDiffCategories.push("copy");
        }
      } else if (whitespaceMatches) {
        bodyDiffCategories.push("whitespace");
      } else if (punctuationMatches) {
        bodyDiffCategories.push("punctuation");
      } else {
        bodyDiffCategories.push("copy");
      }
    }
  }

  return {
    bodyMatchesApproved,
    bodyDiffCategories,
    expectedParameterCount,
    actualParameterCount,
    expectedParameterOccurrences,
    actualParameterOccurrences,
    expectedParameterOccurrenceCount,
    actualParameterOccurrenceCount,
    bodyWithoutParametersMatchesApproved,
    bodyWithoutParametersExactMatchesApproved,
    bodyWithoutParametersDiffCategories,
    parameterDifference,
    headerMatchesApproved:
      opts.header !== null && opts.header === opts.approvedHeader,
    bodyComponentCount: opts.bodyComponentCount,
  };
}

function readonlyDiagnostic(
  diagnostics: WhatsappProviderDiagnostics,
): WhatsappReadOnlyDiagnostic {
  return {
    httpStatus: diagnostics.httpStatus,
    code: diagnostics.code,
    subcode: diagnostics.subcode,
    traceId: diagnostics.traceId,
  };
}

function safeDiagnosticEnum(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return /^[A-Za-z0-9._-]{1,80}$/.test(result) ? result : null;
}

/**
 * Read-only Meta channel inspection for operators and diagnostics.  Every
 * request here is GET-only: it never sends a customer message and never
 * subscribes an app or changes WABA state.
 *
 * The result intentionally omits phone/WABA identifiers, response bodies,
 * access tokens, and provider messages.  Callers can therefore print it in a
 * support report without disclosing customer or credential data.
 */
export async function diagnoseWhatsappChannel(opts: {
  accessToken: string;
  phoneNumberId: string;
  wabaId: string;
  templateName?: string;
  approvedTemplateLanguage?: string;
  approvedTemplateBody?: string;
  approvedTemplateHeader?: string;
  approvedTemplateParameterCount?: number;
}): Promise<WhatsappChannelDiagnostic> {
  const phonePath =
    `${encodeURIComponent(opts.phoneNumberId)}` +
    "?fields=verified_name,display_phone_number,quality_rating,platform_type,status";
  const wabaPath =
    `${encodeURIComponent(opts.wabaId)}/phone_numbers` +
    "?fields=id&limit=100";
  const [phone, waba] = await Promise.all([
    readWhatsappGraph(phonePath, opts.accessToken),
    readWhatsappGraph(wabaPath, opts.accessToken),
  ]);

  const phoneData = asRecord(phone.data);
  const phoneDiagnostic = {
    ...readonlyDiagnostic(phone.diagnostics),
    ok: phone.ok,
    status: safeDiagnosticEnum(phoneData?.status),
    platformType: safeDiagnosticEnum(phoneData?.platform_type),
  };

  const wabaData = asRecord(waba.data);
  const phoneNumbers = Array.isArray(wabaData?.data)
    ? wabaData.data
    : null;
  const senderMembership =
    waba.ok && phoneNumbers
      ? phoneNumbers.some(
          (entry) =>
            asRecord(entry)?.id === opts.phoneNumberId,
        )
      : null;
  const wabaDiagnostic = {
    ...readonlyDiagnostic(waba.diagnostics),
    ok: waba.ok,
    senderMembership,
  };

  let templateDiagnostic: WhatsappChannelDiagnostic["template"] = null;
  if (opts.templateName?.trim()) {
    const templateName = opts.templateName.trim();
    const templateQuery = new URLSearchParams({
      name: templateName,
      fields: "name,language,status,components",
      limit: "100",
    });
    const template = await readWhatsappGraph(
      `${encodeURIComponent(opts.wabaId)}/message_templates?${templateQuery.toString()}`,
      opts.accessToken,
    );
    const templateData = asRecord(template.data);
    const records = Array.isArray(templateData?.data)
      ? templateData.data
      : [];
    const approvedLanguage = opts.approvedTemplateLanguage ?? "";
    const approvedBody = opts.approvedTemplateBody ?? "";
    const templates = records
      .map((record): WhatsappTemplateDiagnostic | null => {
        const row = asRecord(record);
        if (row?.name !== templateName) return null;
        const language =
          typeof row.language === "string" ? row.language : null;
        const status = safeDiagnosticEnum(row.status);
        const components = Array.isArray(row.components)
          ? row.components
          : [];
        const bodyComponents = components.filter((component) => {
          const componentType = asRecord(component)?.type;
          return (
            typeof componentType === "string" &&
            componentType.toUpperCase() === "BODY"
          );
        });
        const bodyComponent = components.find(
          (component) => {
            const componentType = asRecord(component)?.type;
            return (
              typeof componentType === "string" &&
              componentType.toUpperCase() === "BODY"
            );
          },
        );
        const bodyText = asRecord(bodyComponent)?.text;
        const headerComponent = components.find((component) => {
          const componentType = asRecord(component)?.type;
          return (
            typeof componentType === "string" &&
            componentType.toUpperCase() === "HEADER"
          );
        });
        const headerText = asRecord(headerComponent)?.text;
        const structure = compareWhatsappTemplateStructure({
          body: typeof bodyText === "string" ? bodyText : null,
          header: typeof headerText === "string" ? headerText : null,
          bodyComponentCount: bodyComponents.length,
          approvedBody,
          approvedHeader:
            opts.approvedTemplateHeader ??
            SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.header,
          approvedParameterCount:
            opts.approvedTemplateParameterCount ??
            SERVICE_APPOINTMENT_CONFIRMED_BODY_PARAMETER_COUNT,
        });
        return {
          ...readonlyDiagnostic(template.diagnostics),
          language: safeDiagnosticEnum(language),
          languageMatchesApproved: language === approvedLanguage,
          status,
          ...structure,
        };
      })
      .filter((record): record is WhatsappTemplateDiagnostic => record !== null);
    templateDiagnostic = {
      ...readonlyDiagnostic(template.diagnostics),
      ok: template.ok,
      templates,
    };
  }

  return {
    phone: phoneDiagnostic,
    waba: wabaDiagnostic,
    template: templateDiagnostic,
  };
}

/**
 * Which channel runs the guided lead-capture bot. Explicit WHATSAPP_PROVIDER
 * env wins ("meta" | "twilio"); otherwise auto-detect: Meta when its
 * credentials are configured, else Twilio. The non-selected channel falls
 * back to the legacy one-shot intake so it never goes dead.
 */
export function whatsappProvider(): WhatsappProvider {
  const v = (process.env["WHATSAPP_PROVIDER"] || "").trim().toLowerCase();
  if (v === "twilio") return "twilio";
  if (v === "meta") return "meta";
  return whatsappConfig() ? "meta" : "twilio";
}

export function whatsappConfig(): {
  appSecret: string;
  verifyToken: string;
  accessToken: string;
  phoneNumberId: string;
  dealerId: number;
} | null {
  // WhatsApp may run on its own Meta app (separate from the Facebook Lead
  // Ads app); prefer the dedicated secret, fall back to the shared one.
  const appSecret =
    process.env["WHATSAPP_APP_SECRET"] || process.env["META_APP_SECRET"];
  const verifyToken = process.env["META_VERIFY_TOKEN"];
  const accessToken = process.env["WHATSAPP_ACCESS_TOKEN"];
  const phoneNumberId = process.env["WHATSAPP_PHONE_NUMBER_ID"];
  const dealerId = Number(process.env["WHATSAPP_DEALER_ID"]);
  if (
    !appSecret ||
    !verifyToken ||
    !accessToken ||
    !phoneNumberId ||
    !Number.isSafeInteger(dealerId) ||
    dealerId <= 0
  )
    return null;
  return { appSecret, verifyToken, accessToken, phoneNumberId, dealerId };
}

/**
 * Twilio WhatsApp outbound config. Uses TWILIO_WHATSAPP_FROM when set
 * (e.g. the sandbox number), otherwise falls back to TWILIO_PHONE_NUMBER.
 */
export function twilioWhatsappConfig(): {
  accountSid: string;
  authToken: string;
  from: string;
} | null {
  const accountSid = process.env["TWILIO_ACCOUNT_SID"];
  const authToken = process.env["TWILIO_AUTH_TOKEN"];
  const from = (
    process.env["TWILIO_WHATSAPP_FROM"] ||
    process.env["TWILIO_PHONE_NUMBER"] ||
    ""
  ).replace(/[\s()-]/g, "");
  if (!accountSid || !authToken || !from) return null;
  return { accountSid, authToken, from };
}

/** Send a plain WhatsApp text via the Twilio Messages API. */
export async function sendTwilioWhatsappText(
  cfg: { accountSid: string; authToken: string; from: string },
  to: string,
  body: string,
): Promise<void> {
  const client = twilio(cfg.accountSid, cfg.authToken);
  const normalizedTo = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
  const normalizedFrom = cfg.from.startsWith("whatsapp:")
    ? cfg.from
    : `whatsapp:${cfg.from}`;
  await client.messages.create({
    from: normalizedFrom,
    to: normalizedTo,
    body,
  });
}

async function send(
  cfg: { accessToken: string; phoneNumberId: string },
  to: string,
  payload: Record<string, unknown>,
  correlationId?: string,
): Promise<WhatsappSendResult> {
  const safeCorrelationId = safeWhatsappCorrelationId(correlationId);
  let resp: Response;
  try {
    resp = await fetch(
      `${GRAPH_BASE}/${encodeURIComponent(cfg.phoneNumberId)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          ...(safeCorrelationId
            ? { biz_opaque_callback_data: safeCorrelationId }
            : {}),
          ...payload,
        }),
      },
    );
  } catch {
    throw new WhatsappProviderSendError(
      "WhatsApp provider request outcome is unknown",
      "uncertain",
      emptyWhatsappProviderDiagnostics(safeCorrelationId),
    );
  }
  if (!resp.ok) {
    const diagnostics = await responseWhatsappProviderDiagnostics(
      resp,
      safeCorrelationId,
    );
    logger.error(
      {
        status: diagnostics.httpStatus,
        metaCode: diagnostics.code,
        metaSubcode: diagnostics.subcode,
        metaTraceId: diagnostics.traceId,
        correlationId: diagnostics.correlationId,
      },
      "WhatsApp send failed",
    );
    const disposition: WhatsappSendFailureDisposition =
      resp.status === 429
        ? "retryable_rejection"
        : resp.status >= 400 && resp.status < 500
          ? "terminal_rejection"
          : "uncertain";
    throw new WhatsappProviderSendError(
      `WhatsApp Graph API ${resp.status}`,
      disposition,
      diagnostics,
    );
  }
  let data: { messages?: { id?: string }[] };
  try {
    data = (await resp.json()) as { messages?: { id?: string }[] };
  } catch {
    throw new WhatsappProviderSendError(
      "WhatsApp provider response could not be correlated",
      "uncertain",
      parseWhatsappProviderDiagnostics(
        null,
        resp.status,
        safeCorrelationId,
      ),
    );
  }
  const providerMessageId = data.messages?.[0]?.id;
  if (!providerMessageId) {
    throw new WhatsappProviderSendError(
      "WhatsApp Graph API accepted the request without a message id",
      "uncertain",
      parseWhatsappProviderDiagnostics(
        null,
        resp.status,
        safeCorrelationId,
      ),
    );
  }
  return { providerMessageId };
}

export async function sendWhatsappText(
  cfg: { accessToken: string; phoneNumberId: string },
  to: string,
  body: string,
  correlationId?: string,
): Promise<WhatsappSendResult> {
  return send(
    cfg,
    to,
    { type: "text", text: { body, preview_url: false } },
    correlationId,
  );
}

export function whatsappDocumentMessagePayload(opts: {
  mediaId: string;
  filename: string;
  caption?: string;
}): Record<string, unknown> {
  return {
    type: "document",
    document: {
      id: opts.mediaId,
      filename: opts.filename.slice(0, 240),
      ...(opts.caption?.trim()
        ? { caption: opts.caption.trim().slice(0, 1024) }
        : {}),
    },
  };
}

/**
 * Upload a private document to Meta before sending it. A failed upload is
 * always safe to retry because no customer-visible message has been created.
 */
export async function uploadWhatsappDocument(
  cfg: { accessToken: string; phoneNumberId: string },
  opts: { bytes: Uint8Array; filename: string; mimeType: string },
): Promise<string> {
  const form = new FormData();
  const fileBytes = new ArrayBuffer(opts.bytes.byteLength);
  new Uint8Array(fileBytes).set(opts.bytes);
  form.set("messaging_product", "whatsapp");
  form.set(
    "file",
    new Blob([fileBytes], { type: opts.mimeType }),
    opts.filename.slice(0, 240),
  );

  let resp: Response;
  try {
    resp = await fetch(
      `${GRAPH_BASE}/${encodeURIComponent(cfg.phoneNumberId)}/media`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.accessToken}` },
        body: form,
      },
    );
  } catch {
    throw new WhatsappProviderSendError(
      "WhatsApp document upload failed before the customer message was sent",
      "retryable_rejection",
    );
  }

  if (!resp.ok) {
    const diagnostics = await responseWhatsappProviderDiagnostics(resp);
    logger.error(
      {
        status: diagnostics.httpStatus,
        metaCode: diagnostics.code,
        metaSubcode: diagnostics.subcode,
        metaTraceId: diagnostics.traceId,
      },
      "WhatsApp document upload failed",
    );
    throw new WhatsappProviderSendError(
      `WhatsApp media upload API ${resp.status}`,
      resp.status === 429 || resp.status >= 500
        ? "retryable_rejection"
        : "terminal_rejection",
      diagnostics,
    );
  }

  let data: { id?: string };
  try {
    data = (await resp.json()) as { id?: string };
  } catch {
    throw new WhatsappProviderSendError(
      "WhatsApp document upload response was invalid",
      "retryable_rejection",
      parseWhatsappProviderDiagnostics(null, resp.status),
    );
  }
  if (!data.id) {
    throw new WhatsappProviderSendError(
      "WhatsApp document upload returned no media id",
      "retryable_rejection",
      parseWhatsappProviderDiagnostics(null, resp.status),
    );
  }
  return data.id;
}

/** Send a previously uploaded Meta media document to a WhatsApp recipient. */
export async function sendWhatsappDocument(
  cfg: { accessToken: string; phoneNumberId: string },
  to: string,
  opts: { mediaId: string; filename: string; caption?: string },
  correlationId?: string,
): Promise<WhatsappSendResult> {
  return send(
    cfg,
    to,
    whatsappDocumentMessagePayload(opts),
    correlationId,
  );
}

export function whatsappTemplateMessagePayload(opts: {
  name: string;
  language: string;
  body?: string;
  bodyParameters?: readonly string[];
}): Record<string, unknown> {
  const bodyParameters = opts.bodyParameters ?? [opts.body ?? ""];
  if (
    bodyParameters.length === 0 ||
    bodyParameters.some((parameter) => !parameter.trim()) ||
    (opts.name === "service_appointment_confirmed" &&
      bodyParameters.length !== SERVICE_APPOINTMENT_CONFIRMED_BODY_PARAMETER_COUNT)
  ) {
    throw new WhatsappProviderSendError(
      "WhatsApp template body parameters are invalid",
      "terminal_rejection",
    );
  }
  return {
    type: "template",
    template: {
      name: opts.name,
      language: { code: opts.language },
      components: [
        {
          type: "body",
          parameters: bodyParameters.map((text) => ({ type: "text", text })),
        },
      ],
    },
  };
}

/**
 * Send an approved Meta template. AURA's configured service template must
 * contain one body text variable; the intended message is supplied to it.
 */
export async function sendWhatsappTemplate(
  cfg: { accessToken: string; phoneNumberId: string },
  to: string,
  opts: {
    name: string;
    language: string;
    body?: string;
    bodyParameters?: readonly string[];
  },
  correlationId?: string,
): Promise<WhatsappSendResult> {
  return send(
    cfg,
    to,
    whatsappTemplateMessagePayload(opts),
    correlationId,
  );
}

export type WhatsappButton = { id: string; title: string };

/** Reply-button message (max 3 buttons, titles <= 20 chars). */
export async function sendWhatsappButtons(
  cfg: { accessToken: string; phoneNumberId: string },
  to: string,
  body: string,
  buttons: WhatsappButton[],
  correlationId?: string,
): Promise<WhatsappSendResult> {
  return send(cfg, to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  }, correlationId);
}

export type WhatsappListRow = {
  id: string;
  title: string;
  description?: string;
};

/** Channel-agnostic outbound messaging surface for the guided bot. */
export type WhatsappTransport = {
  /** True when the channel supports reply buttons + interactive lists. */
  interactive: boolean;
  /** True when sends are already persisted by the transport itself. */
  durable?: boolean;
  sendText(to: string, body: string): Promise<void>;
  /** Narrow STOP/START acknowledgement path allowed after an opt keyword. */
  sendComplianceText?(to: string, body: string): Promise<void>;
  sendButtons(
    to: string,
    body: string,
    buttons: WhatsappButton[],
  ): Promise<void>;
  sendList(
    to: string,
    opts: {
      body: string;
      buttonLabel: string;
      sectionTitle: string;
      rows: WhatsappListRow[];
    },
  ): Promise<void>;
};

/** Interactive transport over the Meta Cloud (Graph) API. */
export function metaTransport(cfg: {
  accessToken: string;
  phoneNumberId: string;
}): WhatsappTransport {
  return {
    interactive: true,
    sendText: async (to, body) => {
      await sendWhatsappText(cfg, to, body);
    },
    sendComplianceText: async (to, body) => {
      await sendWhatsappText(cfg, to, body);
    },
    sendButtons: async (to, body, buttons) => {
      await sendWhatsappButtons(cfg, to, body, buttons);
    },
    sendList: async (to, opts) => {
      await sendWhatsappList(cfg, to, opts);
    },
  };
}

/**
 * Text-only transport that captures outbound messages so a Twilio webhook
 * can return them as the TwiML reply. The guided bot sends exactly one
 * message per inbound message.
 */
export function captureTransport(): {
  transport: WhatsappTransport;
  messages: string[];
} {
  const messages: string[] = [];
  const push = async (_to: string, body: string): Promise<void> => {
    messages.push(body);
  };
  return {
    messages,
    transport: {
      interactive: false,
      sendText: push,
      sendComplianceText: push,
      // Never called when interactive=false; safe text fallbacks anyway.
      sendButtons: (to, body) => push(to, body),
      sendList: (to, opts) => push(to, opts.body),
    },
  };
}

/** Interactive list message (max 10 rows, titles <= 24 chars). */
export async function sendWhatsappList(
  cfg: { accessToken: string; phoneNumberId: string },
  to: string,
  opts: {
    body: string;
    buttonLabel: string;
    sectionTitle: string;
    rows: WhatsappListRow[];
  },
  correlationId?: string,
): Promise<WhatsappSendResult> {
  return send(cfg, to, {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: opts.body },
      action: {
        button: opts.buttonLabel.slice(0, 20),
        sections: [
          {
            title: opts.sectionTitle.slice(0, 24),
            rows: opts.rows.slice(0, 10).map((r) => ({
              id: r.id,
              title: r.title.slice(0, 24),
              ...(r.description
                ? { description: r.description.slice(0, 72) }
                : {}),
            })),
          },
        ],
      },
    },
  }, correlationId);
}
