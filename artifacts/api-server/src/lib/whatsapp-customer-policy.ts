import type { DealerCustomerPolicy } from "./dealer-customer-policy";
import { TEST_DRIVES_DISABLED } from "./dealer-customer-policy";
import type { WhatsappTransport } from "./whatsapp";

export const PRIVATE_STOCK_REPLY =
  "I can help with model availability and pricing, but exact stock quantities and internal vehicle identifiers aren't shared here.";

export function isShowroomAddressQuestion(text: string): boolean {
  if (/\b(?:service|workshop|servicing)\b/i.test(text) &&
    /\b(?:address|location|located|where)\b/i.test(text)) return true;
  return /\b(?:showroom|dealership|shop|office|you(?:r)?)\b.*\b(?:address|locat(?:ion|ed)|where)\b|\b(?:address|where|locat(?:ion|ed))\b.*\b(?:showroom|dealership|shop|office|you(?:r)?)\b|^(?:what(?:'s| is) (?:the |your )?)?(?:address|location)[? .!]*$/i.test(text);
}

export function isTestDriveRequest(text: string): boolean {
  return /\b(?:test|demo|trial)[\s_-]*driv(?:e|es|ing)\b|\btd_(?:book|slot|date|confirm)\b|\b(?:book|arrange|schedule|reschedule)\b.{0,40}\bdrive\b|\btake\b.{0,30}\bfor a spin\b|\b(?:can|could|may) I drive (?:it|the car|the vehicle)\b/i.test(text);
}

export function isTestDriveStep(step: string | null | undefined): boolean {
  return /^(?:td_|test_drive|testdrive)/i.test(step ?? "");
}

/** Policy intercept runs before BOTH conversational and guided handlers. */
export function customerPolicyReply(
  policy: DealerCustomerPolicy,
  text: string,
  step?: string | null,
): { reply: string; resetTestDriveFlow: boolean } | null {
  if (!policy.testDrivesEnabled && (isTestDriveRequest(text) || isTestDriveStep(step)))
    return { reply: TEST_DRIVES_DISABLED, resetTestDriveFlow: isTestDriveStep(step) };
  if (isShowroomAddressQuestion(text))
    return {
      reply: policy.showroomAddress ?? "Our showroom address hasn't been configured. Please ask our team for the address.",
      resetTestDriveFlow: false,
    };
  return null;
}

/** Detect stock quantities, not every digit: prices, years, model names, menu
 * numbering, appointment times and the supplied street number stay intact. */
export function containsPrivateStock(value: string): boolean {
  if (/\b(?:VIN|vehicle\s*id|internal\s*(?:stock|vehicle)\s*(?:id|code)|stock\s*(?:number|no\.?|id|code|#))\s*(?:is|[:#=-])\s*[A-Z0-9-]+\b/i.test(value))
    return true;
  if (/\b(?:VIN|stock\s*(?:number|no\.?|id|#))\s*(?:is\s*)?[:#=-]?\s*[A-Z0-9][A-Z0-9-]{2,}\b/i.test(value))
    return true;
  if (/\b[A-HJ-NPR-Z0-9]{17,18}\b/i.test(value)) return true;
  const amount = "(?:\\d[\\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|both|a single|a dozen)";
  const expressions = [
    `\\b${amount}\\s+(?:[\\w-]+\\s+){0,4}(?:units?|vehicles?|cars?|ones?)\\b`,
    `\\b${amount}\\s+(?:(?:are|currently|left|still)\\s+)*(?:available|in stock|on hand|remaining)\\b`,
    `\\b(?:stock|quantity|inventory count|units? available)\\s*[:=]\\s*${amount}\\b`,
    `\\b(?:have|got|stock|available|availability)\\s*[:=-]?\\s*(?:only\\s+)?${amount}\\s+(?:[\\w-]+\\s+){0,3}(?:in stock|available|left|remaining)\\b`,
    `\\b${amount}\\s+(?:black|white|red|blue|orange|silver|grey|gray|green)\\b`,
    `\\b${amount}\\s+(?:[\\w-]+\\s+){1,4}(?:available|in stock|left|remaining|on hand)\\b`,
    `\\b(?:we (?:currently )?have|there are|inventory has|stock contains)\\s*:?\\s+${amount}\\b`,
    `\\b(?:available stock|inventory|stock|quantity|stock total)\\s+(?:is|of|at|totals?)\\s+${amount}\\b`,
    `\\b(?:stock|quantity|available|in stock)\\s*[:=-]\\s*${amount}\\b`,
    `\\b(?:stock|quantity)[^\\n.!?]{0,40}[:=]\\s*${amount}\\b`,
  ];
  return expressions.some((expression) =>
    [...value.matchAll(new RegExp(expression, "gi"))].some((match) => {
      // A model year is not a unit count.
      const numeric = match[0].match(/\b\d[\d,]*\b/);
      const n = numeric ? Number(numeric[0].replace(/,/g, "")) : NaN;
      if (n >= 1900 && n <= 2100 && !/\b(?:stock|quantity|units?|count)\b/i.test(match[0])) return false;
      // Preserve monetary amounts: the guard does not strip currency digits.
      const before = value.slice(Math.max(0, (match.index ?? 0) - 16), match.index);
      const after = value.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 10);
      if (/(?:GYD|G\$|\$|price[: ]*)\s*$/i.test(before) || /^\s*(?:GYD|G\$|USD|\$)\b/i.test(after)) return false;
      return true;
    }),
  );
}

export function safeWhatsappReply(value: string, policy: DealerCustomerPolicy): string {
  if (!policy.testDrivesEnabled &&
      (isTestDriveRequest(value) || /\/(?:book-test-drive|test-drive)\//i.test(value)))
    return TEST_DRIVES_DISABLED;
  return containsPrivateStock(value) ? PRIVATE_STOCK_REPLY : value;
}

/** Apply the same final guard to captions, lists and guided/LLM text.
 * Unsafe interactive content becomes plain text, so its buttons cannot offer
 * an action which the policy just refused. */
export function customerSafeTransport(
  transport: WhatsappTransport,
  readPolicy: () => Promise<DealerCustomerPolicy>,
): WhatsappTransport {
  return {
    ...transport,
    sendText: async (to, body) =>
      transport.sendText(to, safeWhatsappReply(body, await readPolicy())),
    sendButtons: async (to, body, buttons) => {
      const text = [body, ...buttons.map((b) => b.title)].join("\n");
      const safe = safeWhatsappReply(text, await readPolicy());
      if (safe !== text) return transport.sendText(to, safe);
      return transport.sendButtons(to, body, buttons);
    },
    sendList: async (to, options) => {
      const text = [options.body, options.sectionTitle, ...options.rows.map((r) =>
        `${r.title} ${r.description ?? ""}`)].join("\n");
      const safe = safeWhatsappReply(text, await readPolicy());
      if (safe !== text) return transport.sendText(to, safe);
      return transport.sendList(to, options);
    },
  };
}