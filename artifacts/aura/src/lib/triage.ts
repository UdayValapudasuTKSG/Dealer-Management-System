export const SLA_DAYS = 5;
/** Leads must be contacted within 24 hours of showing interest. */
export const CONTACT_SLA_HOURS = 24;

export type TriageKind =
  | "gate"
  | "contact"
  | "testDrive"
  | "delivery"
  | "service"
  | "stalled"
  | "quote"
  | "deposit";

export type TriageBucket = "urgent" | "today" | "later";

export type TriageItem = {
  kind: TriageKind;
  bucket: TriageBucket;
  id: string;
  key: string;
  context: string;
  subContext: string;
  /** Assigned advisor / technician, when known. */
  assignee?: string | null;
  /** Hours remaining on the 24h contact SLA (negative = overdue). Only for kind "contact". */
  slaHoursLeft?: number;
  href: string;
  rank: number;
};

type LeadLike = {
  id: number;
  name: string;
  phase: string;
  status: string;
  contactedDate?: string | null;
  testDriveAt?: string | null;
  assignedTo?: string | null;
  quotationSent?: boolean | null;
  stageEnteredAt?: string | null;
  createdAt: string;
};

type DealLike = {
  id: number;
  stage: string;
  depositPaid?: boolean | null;
  customerName?: string | null;
};

type GateLike = {
  id: number;
  title: string;
  priority: string;
  refType?: string | null;
  refId?: number | null;
};

/** Deep-link a pending review to the record it concerns (lead at its stage,
 * deal, delivery…), falling back to the approvals queue. */
function gateHref(g: GateLike): string {
  if (g.refId != null) {
    if (g.refType === "lead") return `/lead/${g.refId}`;
    if (g.refType === "deal") return "/deals";
    if (g.refType === "delivery") return "/deliveries";
  }
  return "/approvals";
}

type DeliveryLike = {
  id: number;
  status: string;
  advisorName?: string | null;
  customerName?: string | null;
  appointmentAt?: string | null;
};

type ServiceOrderLike = {
  id: number;
  status: string;
  vehicleInfo: string;
  technician?: string | null;
  scheduledDate: string;
};

export function daysSince(iso: string | null | undefined): number {
  if (!iso) return 0;
  return Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000),
  );
}

export function hoursSince(iso: string | null | undefined): number {
  if (!iso) return 0;
  return Math.max(0, (Date.now() - new Date(iso).getTime()) / 3_600_000);
}

export function isTodayLocal(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/** Parse a date-only string (YYYY-MM-DD) as LOCAL midnight to avoid UTC day-shift. */
export function isTodayDateOnly(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const datePart = iso.slice(0, 10);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return datePart === today;
}

export function buildTriage(
  leads: LeadLike[] | undefined,
  deals: DealLike[] | undefined,
  gates: GateLike[] | undefined,
  deliveries?: DeliveryLike[],
  serviceOrders?: ServiceOrderLike[],
): { urgent: TriageItem[]; today: TriageItem[]; later: TriageItem[]; total: number } {
  const urgent: TriageItem[] = [];
  const today: TriageItem[] = [];
  const later: TriageItem[] = [];

  for (const g of gates ?? []) {
    urgent.push({
      kind: "gate",
      bucket: "urgent",
      id: g.id.toString(),
      key: `gate-${g.id}`,
      context: g.title,
      subContext: "Approval required",
      href: gateHref(g),
      rank: g.priority === "high" ? 0 : 2,
    });
  }

  for (const lead of leads ?? []) {
    if (lead.phase === "lost") continue;

    let handled = false;

    if (
      !lead.contactedDate &&
      (lead.status === "new" || lead.status === "assigned")
    ) {
      const elapsed = hoursSince(lead.createdAt);
      const left = CONTACT_SLA_HOURS - elapsed;
      const overdue = left <= 0;
      const item: TriageItem = {
        kind: "contact",
        bucket: overdue ? "urgent" : "today",
        id: lead.id.toString(),
        key: `contact-${lead.id}`,
        context: lead.name,
        subContext: overdue
          ? `Contact overdue ${Math.floor(-left)}h past SLA`
          : `Contact within ${Math.max(1, Math.floor(left))}h`,
        assignee: lead.assignedTo ?? null,
        slaHoursLeft: left,
        href: `/lead/${lead.id}`,
        rank: overdue ? 1 : 1,
      };
      (overdue ? urgent : today).push(item);
      handled = true;
    }

    if (isTodayLocal(lead.testDriveAt)) {
      today.push({
        kind: "testDrive",
        bucket: "today",
        id: lead.id.toString(),
        key: `td-${lead.id}`,
        context: lead.name,
        subContext: "Test drive today",
        assignee: lead.assignedTo ?? null,
        href: `/lead/${lead.id}`,
        rank: 0,
      });
      handled = true;
    }

    if (!handled) {
      const inStage = daysSince(lead.stageEnteredAt ?? lead.createdAt);
      if (lead.phase !== "won" && inStage > SLA_DAYS) {
        urgent.push({
          kind: "stalled",
          bucket: "urgent",
          id: lead.id.toString(),
          key: `sla-${lead.id}`,
          context: lead.name,
          subContext: `Stalled ${inStage}d`,
          assignee: lead.assignedTo ?? null,
          href: `/lead/${lead.id}`,
          rank: 3,
        });
      } else if (lead.quotationSent && !lead.testDriveAt && lead.phase !== "won") {
        later.push({
          kind: "quote",
          bucket: "later",
          id: lead.id.toString(),
          key: `quote-${lead.id}`,
          context: lead.name,
          subContext: "Quote sent",
          assignee: lead.assignedTo ?? null,
          href: `/lead/${lead.id}`,
          rank: 4,
        });
      }
    }
  }

  for (const d of deals ?? []) {
    if (
      !d.depositPaid &&
      (d.stage === "negotiation" || d.stage === "desking" || d.stage === "finance")
    ) {
      today.push({
        kind: "deposit",
        bucket: "today",
        id: d.id.toString(),
        key: `deal-${d.id}`,
        context: d.customerName ?? "Deal",
        subContext: "Awaiting deposit",
        href: "/deals",
        rank: 2,
      });
    }
  }

  for (const del of deliveries ?? []) {
    if (del.status !== "in_progress") continue;
    const isToday = isTodayLocal(del.appointmentAt);
    (isToday ? today : later).push({
      kind: "delivery",
      bucket: isToday ? "today" : "later",
      id: del.id.toString(),
      key: `delivery-${del.id}`,
      context: del.customerName ?? `Delivery #${del.id}`,
      subContext: isToday ? "Delivery today" : "Delivery in progress",
      assignee: del.advisorName ?? null,
      href: "/deliveries",
      rank: isToday ? 1 : 5,
    });
  }

  for (const so of serviceOrders ?? []) {
    if (so.status === "completed" || so.status === "delivered") continue;
    if (so.status === "awaiting_approval") {
      urgent.push({
        kind: "service",
        bucket: "urgent",
        id: so.id.toString(),
        key: `service-${so.id}`,
        context: so.vehicleInfo,
        subContext: "Service awaiting approval",
        assignee: so.technician ?? null,
        href: "/service",
        rank: 2,
      });
    } else if (isTodayDateOnly(so.scheduledDate)) {
      today.push({
        kind: "service",
        bucket: "today",
        id: so.id.toString(),
        key: `service-${so.id}`,
        context: so.vehicleInfo,
        subContext:
          so.status === "scheduled" ? "Service due today" : "Service in bay",
        assignee: so.technician ?? null,
        href: "/service",
        rank: 2,
      });
    }
  }

  urgent.sort((a, b) => a.rank - b.rank);
  today.sort((a, b) => a.rank - b.rank);
  later.sort((a, b) => a.rank - b.rank);

  return {
    urgent,
    today,
    later,
    total: urgent.length + today.length + later.length,
  };
}
