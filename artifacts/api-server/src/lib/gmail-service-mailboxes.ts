import crypto from "node:crypto";

export type ServiceInboxRequest = {
  dealerId: number;
  initialSince?: string;
};

export type ServiceInboxCredentialRow = {
  dealerId: number;
  dealerStatus: string;
  host: string;
  username: string;
  enabled: boolean;
  passwordCiphertext: string | null;
};

export type ResolvedServiceInbox = {
  dealerId: number;
  user: string;
  pass: string;
  initialSince: Date;
  identity: string;
  markerId: string;
  ledgerPrefix: string;
};

export type ServiceInboxIssue = {
  dealerId?: number;
  code:
    | "invalid_config"
    | "duplicate_dealer"
    | "not_configured"
    | "dealer_inactive"
    | "disabled"
    | "not_gmail"
    | "missing_credentials"
    | "ownership_conflict"
    | "credential_error";
};

function parseInitialSince(value: unknown, now: Date): Date | null {
  if (value === undefined) return new Date(now);
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== value ||
    parsed.getTime() > now.getTime()
  ) {
    return null;
  }
  return parsed;
}

/** Parse the non-secret allowlist. Invalid entries fail closed. */
export function parseServiceInboxRequests(
  raw: string | undefined,
  now = new Date(),
): { requests: Array<ServiceInboxRequest & { since: Date }>; issues: ServiceInboxIssue[] } {
  if (!raw) return { requests: [], issues: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { requests: [], issues: [{ code: "invalid_config" }] };
  }
  if (!Array.isArray(value)) {
    return { requests: [], issues: [{ code: "invalid_config" }] };
  }
  const requests: Array<ServiceInboxRequest & { since: Date }> = [];
  const issues: ServiceInboxIssue[] = [];
  const seen = new Set<number>();
  for (const entry of value) {
    const candidate = entry as Partial<ServiceInboxRequest> | null;
    const dealerId = candidate?.dealerId;
    const since = parseInitialSince(candidate?.initialSince, now);
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !Number.isSafeInteger(dealerId) ||
      dealerId! <= 0 ||
      !since ||
      Object.keys(candidate).some((key) => !["dealerId", "initialSince"].includes(key))
    ) {
      issues.push({ dealerId, code: "invalid_config" });
      continue;
    }
    if (seen.has(dealerId!)) {
      issues.push({ dealerId, code: "duplicate_dealer" });
      continue;
    }
    seen.add(dealerId!);
    requests.push({ dealerId: dealerId!, initialSince: candidate.initialSince, since });
  }
  return { requests, issues };
}

function normalizedMailbox(value: string): string {
  return value.trim().toLowerCase();
}

/** Resolve only explicitly requested dealers; never discovers SMTP rows. */
export async function resolveServiceInboxes(opts: {
  raw: string | undefined;
  legacyMailboxes: Array<string | undefined>;
  now?: Date;
  loadCredential: (dealerId: number) => Promise<ServiceInboxCredentialRow | null>;
  decrypt: (ciphertext: string, dealerId: number) => string;
}): Promise<{ inboxes: ResolvedServiceInbox[]; issues: ServiceInboxIssue[] }> {
  const parsed = parseServiceInboxRequests(opts.raw, opts.now);
  const issues = [...parsed.issues];
  const inboxes: ResolvedServiceInbox[] = [];
  const owned = new Set(
    opts.legacyMailboxes.filter(Boolean).map((value) => normalizedMailbox(value!)),
  );
  for (const request of parsed.requests) {
    let row: ServiceInboxCredentialRow | null;
    try {
      row = await opts.loadCredential(request.dealerId);
    } catch {
      issues.push({ dealerId: request.dealerId, code: "credential_error" });
      continue;
    }
    if (!row) {
      issues.push({ dealerId: request.dealerId, code: "not_configured" });
      continue;
    }
    const mailbox = normalizedMailbox(row.username);
    const reason =
      row.dealerStatus !== "active"
        ? "dealer_inactive"
        : !row.enabled
          ? "disabled"
          : normalizedMailbox(row.host).replace(/\.$/, "") !== "smtp.gmail.com"
            ? "not_gmail"
            : !mailbox || !row.passwordCiphertext
              ? "missing_credentials"
              : owned.has(mailbox)
                ? "ownership_conflict"
                : null;
    if (reason) {
      issues.push({ dealerId: request.dealerId, code: reason });
      continue;
    }
    try {
      const identity = crypto
        .createHash("sha256")
        .update(`${request.dealerId}:${mailbox}`)
        .digest("hex")
        .slice(0, 20);
      inboxes.push({
        dealerId: request.dealerId,
        user: mailbox,
        pass: opts.decrypt(row.passwordCiphertext!, request.dealerId),
        initialSince: request.since,
        identity,
        markerId: `enabled_at:service:${request.dealerId}:${identity}`,
        ledgerPrefix: `service:${request.dealerId}:${identity}:`,
      });
      owned.add(mailbox);
    } catch {
      issues.push({ dealerId: request.dealerId, code: "credential_error" });
    }
  }
  return { inboxes, issues };
}

export function serviceInboxSearch(since: Date): { since: Date } {
  return { since };
}

export function shouldFetchServiceSource(input: {
  subject: string;
  internalDate?: Date;
  since: Date;
  alreadyProcessed: boolean;
}): boolean {
  return (
    !input.alreadyProcessed &&
    (!input.internalDate || input.internalDate >= input.since) &&
    input.subject.toLowerCase().includes(
      "website contact form | book your service online",
    )
  );
}