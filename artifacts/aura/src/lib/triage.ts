export const SLA_DAYS = 5;

export type TriageKind =
  | "gate"
  | "contact"
  | "testDrive"
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
};

export function daysSince(iso: string | null | undefined): number {
  if (!iso) return 0;
  return Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000),
  );
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

export function buildTriage(
  leads: LeadLike[] | undefined,
  deals: DealLike[] | undefined,
  gates: GateLike[] | undefined,
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
      href: "/approvals",
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
      today.push({
        kind: "contact",
        bucket: "today",
        id: lead.id.toString(),
        key: `contact-${lead.id}`,
        context: lead.name,
        subContext: "New lead",
        href: `/lead/${lead.id}`,
        rank: 1,
      });
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
