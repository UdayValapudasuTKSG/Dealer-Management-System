/**
 * Pure shipment-allocation rules (no DB). Covered by rules.test.ts.
 */

export const NA = "N/A";
export function shipmentEmailEligible(a: {
  production: boolean; allocationStatus?: string; shipmentStatus?: string;
  jobStatus?: string; currentEta?: string; eventEta: string; leadMatches: boolean;
  kind: string; now: Date; timezone: string;
}): boolean {
  return a.production && ["active", "fulfilled"].includes(a.allocationStatus ?? "") &&
    ["open", "in_transit", "arrived"].includes(a.shipmentStatus ?? "") &&
    ["queued", "failed"].includes(a.jobStatus ?? "") && a.currentEta === a.eventEta &&
    a.leadMatches && (a.kind === "initial" ||
      (a.kind === "eta_change" && etaChangeWithinWindow(a.eventEta, a.now, a.timezone)));
}
export const MONTH_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
export const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
export const LEASE_TTL_MS = 5 * 60 * 1000;

export const ETA_EMAIL_RULE =
  "New allocations queue a dealership-branded email in production. ETA-change emails qualify only for the current or next dealership calendar month. Development notifications are withheld. Customer preferences and the dealership SMTP configuration apply; historical withheld events are never replayed automatically.";

export const TEMPLATE_WITHHELD_REASON =
  "Withheld in development: no customer shipment email was sent. This event will not be replayed automatically.";

export type SpecFields = {
  make: string;
  model: string;
  year: number;
  variant: string;
  exteriorColor: string;
  interiorColor: string;
};

/** Trim + collapse whitespace; "n/a" variants normalise to canonical N/A. */
export function normaliseSpecText(value: string): string {
  const v = value.trim().replace(/\s+/g, " ");
  if (/^n\s*\/?\s*a$/i.test(v)) return NA;
  return v;
}

/** Blank is never a wildcard: returns an error string when blank. */
export function specFieldError(label: string, value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return `${label} is blank - enter a value or explicit N/A`;
  return null;
}

export function specKey(s: SpecFields): string {
  return [s.make, s.model, String(s.year), s.variant, s.exteriorColor, s.interiorColor]
    .map((x) => normaliseSpecText(x).toLowerCase())
    .join("|");
}

export function specLabel(s: SpecFields): string {
  return `${s.year} ${s.make} ${s.model} ${s.variant} - ${s.exteriorColor} / ${s.interiorColor}`;
}

export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/**
 * Conservative ETA-change notification window: the revised ETA month must be
 * no later than next calendar month (relative to `now`).
 */
export function etaChangeWithinWindow(revisedMonth: string, now: Date, timeZone = "UTC"): boolean {
  const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(now);
  const current = `${parts.find(p => p.type === "year")!.value}-${parts.find(p => p.type === "month")!.value}`;
  return MONTH_RE.test(revisedMonth) && revisedMonth >= current && revisedMonth <= addMonths(current, 1);
}

export type CapacityResult =
  | { ok: true; quantity: number; partial: boolean }
  | { ok: false; reason: string };

/** Full-line allocation unless the customer explicitly consented to partial. */
export function allocateCapacity(
  lineQuantity: number,
  activeAllocated: number,
  requested: number,
  partialConsent: boolean,
): CapacityResult {
  if (!Number.isInteger(requested) || requested < 1)
    return { ok: false, reason: "Requested quantity must be a positive whole number" };
  const remaining = Math.max(0, lineQuantity - activeAllocated);
  if (requested <= remaining) return { ok: true, quantity: requested, partial: false };
  if (remaining === 0) return { ok: false, reason: "No remaining capacity on this line" };
  if (!partialConsent)
    return {
      ok: false,
      reason: `Only ${remaining} of ${requested} units remain. Full allocation only - record the customer's explicit partial consent to take ${remaining}.`,
    };
  return { ok: true, quantity: remaining, partial: true };
}

/** Allowed shipment status transitions (closing/cancelling also guarded by data checks). */
export const SHIPMENT_TRANSITIONS: Record<string, string[]> = {
  open: ["in_transit", "cancelled"],
  in_transit: ["open", "arrived", "cancelled"],
  arrived: ["closed"],
  closed: [],
  cancelled: [],
};

export function shipmentAcceptsAllocations(status: string): "yes" | "reconciled_only" | "no" {
  if (status === "open" || status === "in_transit") return "yes";
  if (status === "arrived") return "reconciled_only";
  return "no";
}

export type LeaseRow = { holderUserId: number; expiresAt: Date } | null | undefined;

export function evaluateLease(lock: LeaseRow, userId: number, now: Date): "free" | "mine" | "other" {
  if (!lock || lock.expiresAt.getTime() <= now.getTime()) return "free";
  return lock.holderUserId === userId ? "mine" : "other";
}

// ---------------------------------------------------------------- matching

export type DemandUnit = {
  allocationId: number;
  baselineAt: Date;
  remaining: number;
  partialConsent: boolean;
};
export type MatchPlan = {
  assignments: { allocationId: number; manifestId: number }[];
  shortages: { allocationId: number; unitsShort: number; reason: string }[];
  unmatchedManifestIds: number[];
};

/** Deterministic-from-rng Fisher-Yates shuffle. */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Exact-spec matching for ONE spec group. Oldest baseline first (id breaks
 * ties). VIN identities are random within the group. A shortage on an older
 * allocation is never bypassed by a younger one: once an older allocation
 * cannot be fully served (and has no partial consent), every younger
 * allocation in the group waits, and the VINs stay unmatched.
 */
export function planGroupMatches(
  manifestIds: readonly number[],
  demand: readonly DemandUnit[],
  rng: () => number,
): MatchPlan {
  const pool = shuffle(manifestIds, rng);
  const ordered = demand
    .filter((d) => d.remaining > 0)
    .slice()
    .sort((a, b) => a.baselineAt.getTime() - b.baselineAt.getTime() || a.allocationId - b.allocationId);
  const assignments: MatchPlan["assignments"] = [];
  const shortages: MatchPlan["shortages"] = [];
  let blockedBy: number | null = null;
  for (const d of ordered) {
    if (blockedBy != null) {
      shortages.push({
        allocationId: d.allocationId,
        unitsShort: d.remaining,
        reason: `Waiting behind older allocation #${blockedBy} - shortages cannot bypass earlier priority`,
      });
      continue;
    }
    if (pool.length >= d.remaining) {
      for (let i = 0; i < d.remaining; i += 1)
        assignments.push({ allocationId: d.allocationId, manifestId: pool.shift()! });
      continue;
    }
    if (d.partialConsent && pool.length > 0) {
      const take = pool.length;
      for (let i = 0; i < take; i += 1)
        assignments.push({ allocationId: d.allocationId, manifestId: pool.shift()! });
      shortages.push({
        allocationId: d.allocationId,
        unitsShort: d.remaining - take,
        reason: `Partial consent on file - ${take} matched, ${d.remaining - take} still awaiting VINs`,
      });
      blockedBy = d.allocationId;
      continue;
    }
    shortages.push({
      allocationId: d.allocationId,
      unitsShort: d.remaining,
      reason: `Only ${pool.length} VIN(s) available for ${d.remaining} unit(s); full-line fulfilment required`,
    });
    blockedBy = d.allocationId;
  }
  return { assignments, shortages, unmatchedManifestIds: pool };
}

// ---------------------------------------------------------------- import

export type ImportRowInput = {
  rowNumber: number;
  vin?: string | null;
  make?: string | null;
  model?: string | null;
  year?: string | null;
  variant?: string | null;
  exteriorColor?: string | null;
  interiorColor?: string | null;
  quantity?: string | null;
};

export type ImportContext = {
  kind: "lines" | "manifest";
  /** approved spec key -> spec id */
  approvedSpecs: Map<string, number>;
  /** any (non-approved) spec key -> status, for clearer errors */
  otherSpecs: Map<string, string>;
  /** spec ids that already have a line on this shipment */
  existingLineSpecIds: Set<number>;
  /** spec id -> line quantity (manifest kind) */
  lineQuantity: Map<number, number>;
  /** spec id -> manifest VINs already on this shipment */
  manifestCount: Map<number, number>;
  /** VINs that already exist for this dealer (any shipment) */
  existingVins: Set<string>;
};

export type ValidatedRow =
  | { rowNumber: number; ok: true; specId: number; quantity?: number; vin?: string; message: string }
  | { rowNumber: number; ok: false; message: string };

export function validateImportRows(rows: readonly ImportRowInput[], ctx: ImportContext): ValidatedRow[] {
  const seenVins = new Set<string>();
  const seenSpecs = new Set<number>();
  const pendingManifest = new Map<number, number>();
  return rows.map((r): ValidatedRow => {
    const errors: string[] = [];
    const fields: [string, string | null | undefined][] = [
      ["Make", r.make],
      ["Model", r.model],
      ["Variant", r.variant],
      ["Exterior colour", r.exteriorColor],
      ["Interior colour", r.interiorColor],
    ];
    for (const [label, v] of fields) {
      const e = specFieldError(label, v);
      if (e) errors.push(e);
    }
    const year = Number((r.year ?? "").trim());
    if (!Number.isInteger(year) || year < 1990 || year > 2100) errors.push("Year must be a 4-digit model year");
    let quantity: number | undefined;
    let vin: string | undefined;
    if (ctx.kind === "lines") {
      quantity = Number((r.quantity ?? "").trim());
      if (!Number.isInteger(quantity) || quantity < 1) {
        errors.push("Quantity must be a positive whole number");
        quantity = undefined;
      }
    } else {
      vin = (r.vin ?? "").trim().toUpperCase();
      if (!VIN_RE.test(vin)) errors.push("VIN must be 17 characters (A-Z, 0-9, no I/O/Q)");
      else if (seenVins.has(vin)) errors.push("Duplicate VIN within this file");
      else if (ctx.existingVins.has(vin)) errors.push("VIN already on a manifest for this dealership");
    }
    if (errors.length) return { rowNumber: r.rowNumber, ok: false, message: errors.join("; ") };
    const key = specKey({
      make: r.make!,
      model: r.model!,
      year,
      variant: r.variant!,
      exteriorColor: r.exteriorColor!,
      interiorColor: r.interiorColor!,
    });
    const specId = ctx.approvedSpecs.get(key);
    if (specId == null) {
      const other = ctx.otherSpecs.get(key);
      return {
        rowNumber: r.rowNumber,
        ok: false,
        message: other
          ? `Specification exists but is ${other}; a manager must approve it first`
          : "Unknown specification - not in the approved catalogue (exact match required)",
      };
    }
    if (ctx.kind === "lines") {
      if (ctx.existingLineSpecIds.has(specId))
        return { rowNumber: r.rowNumber, ok: false, message: "A line for this specification already exists - edit its quantity instead" };
      if (seenSpecs.has(specId))
        return { rowNumber: r.rowNumber, ok: false, message: "Duplicate specification within this file" };
      seenSpecs.add(specId);
      return { rowNumber: r.rowNumber, ok: true, specId, quantity, message: `Line: ${quantity} unit(s)` };
    }
    const lineQty = ctx.lineQuantity.get(specId);
    if (lineQty == null)
      return { rowNumber: r.rowNumber, ok: false, message: "Specification is not on this shipment's lines" };
    const used = (ctx.manifestCount.get(specId) ?? 0) + (pendingManifest.get(specId) ?? 0);
    if (used >= lineQty)
      return { rowNumber: r.rowNumber, ok: false, message: `Exceeds line quantity (${lineQty}) for this specification` };
    pendingManifest.set(specId, (pendingManifest.get(specId) ?? 0) + 1);
    seenVins.add(vin!);
    return { rowNumber: r.rowNumber, ok: true, specId, vin, message: `VIN ${vin}` };
  });
}
