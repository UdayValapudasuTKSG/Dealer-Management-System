/**
 * Parser for the public "Book Your Service Online" form notification.
 *
 * This intentionally has no mail or database dependencies.  Gmail relay
 * messages frequently contain both a forwarded-message header and a HTML
 * table, so identity is taken only from labelled form fields below.
 */

export const SERVICE_BOOKING_SUBJECT_PHRASE =
  "website contact form | book your service online";

/** Execute one delivery only after its unique ledger claim succeeds. */
export async function runAtomicInboundDeliveryOnce<TClaim, TResult>(
  claim: () => Promise<TClaim | null>,
  create: (claim: TClaim) => Promise<TResult>,
): Promise<TResult | null> {
  const claimed = await claim();
  if (claimed == null) return null;
  return create(claimed);
}

export type ServiceBookingForm = {
  name: string | null;
  email: string | null;
  phone: string | null;
  model: string | null;
  preferredDate: string | null;
  waitOrDropoff: string | null;
  services: string | null;
  issues: string[];
};

/** Match the canonical form phrase after any Re/Fwd/[EXTERNAL] prefixes. */
export function isServiceBookingSubject(subject: string | null | undefined): boolean {
  return (
    typeof subject === "string" &&
    subject.toLowerCase().includes(SERVICE_BOOKING_SUBJECT_PHRASE)
  );
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (_all, entity: string) => {
      if (entity.toLowerCase().startsWith("#x")) {
        return String.fromCodePoint(parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith("#")) {
        return String.fromCodePoint(parseInt(entity.slice(1), 10));
      }
      return named[entity.toLowerCase()] ?? _all;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function htmlText(value: string): string {
  return decodeHtml(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  );
}

function normalizedLabel(value: string): string {
  return decodeHtml(value)
    .toLowerCase()
    .replace(/[?*:：]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

type FieldKey =
  | "name"
  | "email"
  | "phone"
  | "model"
  | "preferredDate"
  | "waitOrDropoff"
  | "services";

function fieldKey(label: string): FieldKey | null {
  const key = normalizedLabel(label);
  if (key === "name" || key === "full name" || key === "customer name") return "name";
  if (key === "email" || key === "email address") return "email";
  if (key === "phone" || key === "phone number" || key === "telephone") return "phone";
  if (key === "model" || key === "vehicle model" || key === "vehicle") return "model";
  if (key === "preferred date" || key === "requested date") return "preferredDate";
  if (
    key === "wait for or drop off vehicle" ||
    key === "wait or drop off vehicle" ||
    key === "vehicle handoff"
  ) {
    return "waitOrDropoff";
  }
  if (
    key === "select one or more services below" ||
    key === "services" ||
    key === "service"
  ) {
    return "services";
  }
  return null;
}

function addPair(map: Map<FieldKey, string>, label: string, value: string): void {
  const key = fieldKey(label);
  const cleanValue = htmlText(value);
  if (!key || !cleanValue || map.has(key)) return;
  map.set(key, cleanValue);
}

function startsWithKnownLabel(value: string): boolean {
  return /^(Name|Full Name|Customer Name|Email(?: Address)?|Phone(?: Number)?|Telephone|Model|Vehicle(?: Model)?|Preferred Date|Requested Date|Wait for(?: or drop off)? vehicle|Wait(?: for)? or drop off vehicle|Vehicle Handoff|Select one or more services below|Services?)\??\s*[:：-]/i.test(
    value.trim(),
  );
}

function extractPairs(text: string, html: string | null | undefined): Map<FieldKey, string> {
  const pairs = new Map<FieldKey, string>();

  // Read table rows first.  This avoids forwarding headers such as
  // "From: relay@example.com" being mistaken for customer identity.
  if (html) {
    const rows = html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);
    for (const row of rows) {
      const cells = [...row[1]!.matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)]
        .map((cell) => htmlText(cell[1]!))
        .filter(Boolean);
      if (cells.length >= 2) addPair(pairs, cells[0]!, cells.slice(1).join(" "));
    }
  }

  // Plain-text notifications generally use one labelled field per line.
  // A label-only line followed by its value is also supported.
  const lines = html ? htmlText(html).split(/\r?\n/) : text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const inline = line.match(
      /^(Name|Full Name|Customer Name|Email(?: Address)?|Phone(?: Number)?|Telephone|Model|Vehicle(?: Model)?|Preferred Date|Requested Date|Wait for(?: or drop off)? vehicle|Wait(?: for)? or drop off vehicle|Vehicle Handoff|Select one or more services below|Services?)\??\s*[:：-]\s*(.+)$/i,
    );
    if (inline) {
      addPair(pairs, inline[1]!, inline[2]!);
      continue;
    }
    const key = fieldKey(line);
    if (key && !pairs.has(key)) {
      const next = lines[i + 1]?.trim();
      if (next && !startsWithKnownLabel(next) && !fieldKey(next)) {
        addPair(pairs, line, next);
      }
    }
  }
  return pairs;
}

function normalizeEmail(value: string | null): string | null {
  const email = value?.trim().toLowerCase() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/** Returns digits in display-independent form while retaining an explicit +. */
export function normalizeServicePhone(value: string | null | undefined): string | null {
  const raw = value?.trim() ?? "";
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return raw.startsWith("+") ? `+${digits}` : digits;
}

function dateOnly(value: string | null): string | null {
  if (!value) return null;
  const clean = value
    .trim()
    .replace(/(\d)(st|nd|rd|th)\b/gi, "$1")
    .replace(/\s+/g, " ");
  let year: number;
  let month: number;
  let day: number;
  let match = clean.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    const months =
      "january february march april may june july august september october november december".split(
        " ",
      );
    match = clean.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/) ??
      clean.match(/^(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/);
    if (match) {
      const firstIsMonth = /^[A-Za-z]/.test(match[1]!);
      const monthName = (firstIsMonth ? match[1] : match[2])!.toLowerCase();
      month = months.findIndex((name) => name === monthName || name.startsWith(monthName)) + 1;
      day = Number(firstIsMonth ? match[2] : match[1]);
      year = Number(match[3]);
    } else {
      // Numeric dates from form providers are month/day/year.
      match = clean.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
      if (!match) return null;
      month = Number(match[1]);
      day = Number(match[2]);
      year = Number(match[3]);
    }
  }
  const result = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    !Number.isFinite(result.getTime()) ||
    result.getUTCFullYear() !== year ||
    result.getUTCMonth() + 1 !== month ||
    result.getUTCDate() !== day ||
    year! < 2000 ||
    year! > 2100
  ) {
    return null;
  }
  return result.toISOString().slice(0, 10);
}

export function parseServiceBookingForm(input: {
  text?: string | null;
  html?: string | null;
}): ServiceBookingForm {
  const pairs = extractPairs(input.text?.trim() ?? "", input.html);
  const rawName = pairs.get("name")?.trim() || null;
  const rawEmail = pairs.get("email")?.trim() || null;
  const rawPhone = pairs.get("phone")?.trim() || null;
  const rawModel = pairs.get("model")?.trim() || null;
  const rawDate = pairs.get("preferredDate")?.trim() || null;
  const name = rawName || null;
  const email = normalizeEmail(rawEmail);
  const phone = normalizeServicePhone(rawPhone);
  const model = rawModel || null;
  const preferredDate = dateOnly(rawDate);
  const issues: string[] = [];
  if (!name) issues.push("Name is missing");
  if (!email) issues.push("Email is missing or invalid");
  if (!phone) issues.push("Phone is missing or invalid");
  if (!model) issues.push("Model is missing");
  if (!preferredDate) issues.push("Preferred date is missing or invalid");
  if (!pairs.get("waitOrDropoff")?.trim()) {
    issues.push("Vehicle handoff preference is missing");
  }
  if (!pairs.get("services")?.trim()) {
    issues.push("Requested service is missing");
  }
  return {
    name,
    email,
    phone,
    model,
    preferredDate,
    waitOrDropoff: pairs.get("waitOrDropoff") ?? null,
    services: pairs.get("services") ?? null,
    issues,
  };
}