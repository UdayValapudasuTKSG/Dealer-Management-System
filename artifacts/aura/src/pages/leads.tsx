import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  useListDeals,
  useListLeads,
  useListVehicles,
  useCreateLead,
  useListLeadSources,
  getListLeadsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Plus,
  Phone,
  Mail,
  ArrowUpRight,
  Car,
  Clock,
  UserCheck,
  Search,
} from "lucide-react";
import { motion } from "framer-motion";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { VehicleCascade } from "@/components/vehicle-cascade";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useViewMode } from "@/hooks/use-view-mode";
import { ViewControls } from "@/components/view-controls";
import { useAuthz } from "@/lib/auth";
import { CONTACT_SLA_HOURS, hoursSince, humanHours } from "@/lib/triage";

const STAGES = [
  "new_lead",
  "contacted",
  "engaged",
  "pre_book",
  "vehicle_allocated",
  "payment",
  "pre_delivery",
  "delivered",
] as const;
type Stage = (typeof STAGES)[number];

const STAGE_LABEL: Record<Stage, string> = {
  new_lead: "New",
  contacted: "Contacted",
  engaged: "Engaged",
  pre_book: "Pre-Book",
  vehicle_allocated: "Vehicle Allocated",
  payment: "Payment",
  pre_delivery: "Pre-Delivery",
  delivered: "Delivered",
};

// Four master phases drive the queue tabs; the 8 rail stages fold into them.
type Macro = "lead" | "prebooking" | "payment" | "delivery";

const MACRO_OF: Record<Stage, Macro> = {
  new_lead: "lead",
  contacted: "lead",
  engaged: "lead",
  pre_book: "prebooking",
  vehicle_allocated: "prebooking",
  payment: "payment",
  pre_delivery: "delivery",
  delivered: "delivery",
};

const MACRO_LABEL: Record<Macro, string> = {
  lead: "Lead",
  prebooking: "Pre-Booking",
  payment: "Payment",
  delivery: "Delivery",
};

const MACRO_ORDER: Macro[] = ["lead", "prebooking", "payment", "delivery"];

const SOURCE_LABEL: Record<string, string> = {
  website: "Website",
  walk_in: "Walk-in",
  phone: "Phone",
  facebook: "Facebook",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
  referral: "Referral",
  social_media: "Social Media",
};

const SOCIAL_SUB_PLATFORMS = [
  { value: "facebook", label: "Facebook" },
  { value: "instagram", label: "Instagram" },
  { value: "tiktok", label: "TikTok" },
  { value: "youtube", label: "YouTube" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "other", label: "Other" },
];

const STATUS_LABEL: Record<string, string> = {
  new: "New",
  assigned: "Assigned",
  contacted: "Contacted",
  qualified: "Qualified",
  test_drive: "Test Drive",
  back_order: "Back Order",
  decision: "Decision",
  engaged: "Engaged",
  converted: "Converted",
  lost: "Lost",
};

const PRIORITY_STYLE: Record<string, string> = {
  high: "bg-primary/15 text-primary ring-primary/30",
  medium: "bg-amber-500/15 text-amber-400 ring-amber-500/30",
  low: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30",
};

const withBase = (url: string) =>
  `${import.meta.env.BASE_URL}${url.replace(/^\//, "")}`;

/** Contact SLA: 24h from createdAt until the lead is contacted. Null once
 * contacted (or past the contacted status). */
function contactSla(lead: {
  status: string;
  contactedDate?: Date | string | null;
  createdAt: Date | string;
}): { left: number; overdue: boolean } | null {
  const contacted =
    !!lead.contactedDate ||
    (lead.status !== "new" && lead.status !== "assigned");
  if (contacted) return null;
  const elapsed = hoursSince(String(lead.createdAt));
  const left = CONTACT_SLA_HOURS - elapsed;
  return { left, overdue: left <= 0 };
}

type TabKey = "all" | "mine" | Macro | "lost";

export default function Leads() {
  const { data: leads, isLoading } = useListLeads();
  const { data: vehicles } = useListVehicles();
  const { data: deals } = useListDeals();
  const { data: leadSources } = useListLeadSources();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createLead = useCreateLead();
  const { me } = useAuthz();
  const { density, setDensity, layout, setLayout } = useViewMode("pipeline");
  const [, navigate] = useLocation();

  // Social sub-platform lives outside the dialog's own field state because
  // its visibility depends on the selected source (config-driven).
  const [newSource, setNewSource] = useState<string>("");
  const [sourceDetail, setSourceDetail] = useState<string>("");
  const selectedSourceCfg = (leadSources ?? []).find(
    (s) => s.code === (newSource || "website"),
  );

  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<TabKey>("all");

  const compact = density === "compact";
  const myId = me?.id ?? null;
  const myName = me?.name?.trim().toLowerCase() ?? null;

  // Derive the rail stage for a lead: pre-sale stages map 1:1 from the lead
  // phase; won leads split into Vehicle Allocated / Payment / Pre-Delivery /
  // Delivered by their furthest-along linked deal. Lost leads → null.
  const stageOf = useMemo(() => {
    const rank = (stage: string) =>
      stage === "delivered"
        ? 3
        : stage === "committed"
          ? 2
          : stage === "finance"
            ? 1
            : 0;
    const dealByLead = new Map<number, string>();
    const dealByCustomer = new Map<number, string>();
    for (const d of deals ?? []) {
      if (d.leadId != null) {
        const prev = dealByLead.get(d.leadId);
        if (prev === undefined || rank(d.stage) > rank(prev))
          dealByLead.set(d.leadId, d.stage);
      }
      if (d.customerId != null) {
        const prev = dealByCustomer.get(d.customerId);
        if (prev === undefined || rank(d.stage) > rank(prev))
          dealByCustomer.set(d.customerId, d.stage);
      }
    }
    return (l: {
      id: number;
      phase: string;
      customerId?: number | null;
    }): Stage | null => {
      switch (l.phase) {
        case "aware":
          return "new_lead";
        case "consider":
          return "contacted";
        case "engage":
          return "engaged";
        case "negotiate":
          return "pre_book";
        case "won": {
          const dealStage =
            dealByLead.get(l.id) ??
            (l.customerId != null
              ? dealByCustomer.get(l.customerId)
              : undefined);
          if (dealStage === "delivered") return "delivered";
          if (dealStage === "committed") return "pre_delivery";
          if (dealStage === "finance") return "payment";
          return "vehicle_allocated";
        }
        default:
          return null; // lost
      }
    };
  }, [deals]);

  const isMine = (l: {
    ownerUserId?: number | null;
    assignedTo?: string | null;
  }) =>
    (myId != null && l.ownerUserId === myId) ||
    (l.ownerUserId == null &&
      myName != null &&
      (l.assignedTo ?? "").trim().toLowerCase() === myName);

  // Enrich every lead once with its stage, macro phase, vehicle and SLA.
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (leads ?? [])
      .map((lead) => {
        const stage = stageOf(lead);
        const macro = stage ? MACRO_OF[stage] : null;
        const vehicle = vehicles?.find(
          (v) => v.id === lead.interestedVehicleId,
        );
        const model = vehicle
          ? `${vehicle.make} ${vehicle.model}`
          : lead.selectedModel ?? null;
        const sla = contactSla(lead);
        return { lead, stage, macro, vehicle, model, sla };
      })
      .filter((r) => {
        if (!q) return true;
        const l = r.lead;
        return (
          l.name.toLowerCase().includes(q) ||
          (r.model ?? "").toLowerCase().includes(q) ||
          (l.phone ?? "").toLowerCase().includes(q) ||
          (l.email ?? "").toLowerCase().includes(q) ||
          (l.assignedTo ?? "").toLowerCase().includes(q)
        );
      });
  }, [leads, vehicles, stageOf, search]);

  const counts = useMemo(() => {
    const c: Record<TabKey, number> = {
      all: 0,
      mine: 0,
      lead: 0,
      prebooking: 0,
      payment: 0,
      delivery: 0,
      lost: 0,
    };
    for (const r of rows) {
      c.all += 1;
      if (isMine(r.lead)) c.mine += 1;
      if (r.macro) c[r.macro] += 1;
      else c.lost += 1;
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, myId, myName]);

  const visible = useMemo(() => {
    return rows.filter((r) => {
      switch (tab) {
        case "all":
          return true;
        case "mine":
          return isMine(r.lead);
        case "lost":
          return r.macro === null;
        default:
          return r.macro === tab;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, tab, myId, myName]);

  const TABS: { key: TabKey; label: string }[] = [
    { key: "all", label: "All" },
    { key: "mine", label: "Mine" },
    ...MACRO_ORDER.map((m) => ({ key: m as TabKey, label: MACRO_LABEL[m] })),
    { key: "lost", label: "Lost" },
  ];

  function SlaChip({ sla }: { sla: { left: number; overdue: boolean } | null }) {
    if (!sla) {
      return (
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">
          <Clock className="w-3 h-3" />
          Contacted
        </span>
      );
    }
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full",
          sla.overdue
            ? "text-red-400 bg-red-500/10"
            : "text-amber-400 bg-amber-500/10",
        )}
      >
        <Clock className="w-3 h-3" />
        {sla.overdue
          ? `Overdue ${humanHours(-sla.left)}`
          : `${Math.max(1, Math.floor(sla.left))}h left`}
      </span>
    );
  }

  return (
    <>
      <PageHero
        eyebrow="Sales"
        title="Pipeline"
        subtitle="Every lead, from first enquiry to delivery."
      />
      <Page className="space-y-5 pt-0">
        {/* Command row: search + view toggle + New Lead */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search name, model, phone or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-full bg-foreground/[0.04] border border-white/10 pl-9 pr-4 py-2 text-sm focus:outline-none focus:border-primary/50"
            />
          </div>
          <div className="flex items-center gap-3 ml-auto">
            <ViewControls
              layout={layout}
              onLayoutChange={setLayout}
              density={density}
              onDensityChange={setDensity}
            />
            <CreateRecordDialog
              title="New Lead"
              description="Capture a prospect — AURA scores and routes it instantly."
              pending={createLead.isPending}
              submitLabel="Add to pipeline"
              trigger={
                <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2 font-medium tracking-wide">
                  <Plus className="w-5 h-5" />
                  New Lead
                </Button>
              }
              fields={[
                { name: "name", label: "Name", type: "text", required: true, span: "full", placeholder: "Kojo Asante" },
                {
                  name: "channel",
                  label: "Channel",
                  type: "select",
                  required: true,
                  span: "half",
                  defaultValue: "web",
                  options: [
                    { value: "web", label: "Web" },
                    { value: "social", label: "Social" },
                    { value: "mobile", label: "Mobile" },
                    { value: "walkin", label: "Walk-in" },
                  ],
                },
                {
                  name: "interestedVehicleId",
                  label: "Interested vehicle",
                  type: "custom",
                  required: true,
                  span: "full",
                  render: (_value, set) => (
                    <VehicleCascade
                      vehicles={(vehicles ?? []).map((v) => ({
                        id: v.id,
                        brand: v.make,
                        model: v.model,
                        version: v.trim || v.variant || "Standard specification",
                        color: v.exteriorColor,
                        year: v.year,
                        vin: v.vin ?? null,
                        price: v.price,
                      }))}
                      onResolve={(v) => set(v ? String(v.id) : "")}
                    />
                  ),
                },
                {
                  name: "source",
                  label: "Source",
                  type: "select",
                  span: "half",
                  defaultValue: "website",
                  options:
                    leadSources && leadSources.length > 0
                      ? leadSources.map((s) => ({ value: s.code, label: s.name }))
                      : Object.entries(SOURCE_LABEL).map(([value, label]) => ({
                          value,
                          label,
                        })),
                  onChange: (v: string) => {
                    setNewSource(v);
                    setSourceDetail("");
                  },
                },
                ...(selectedSourceCfg?.isSocial
                  ? [
                      {
                        name: "sourceDetail",
                        label: "Social platform",
                        type: "custom" as const,
                        required: true,
                        span: "half" as const,
                        render: (_value: string, set: (v: string) => void) => (
                          <select
                            value={sourceDetail}
                            onChange={(e) => {
                              setSourceDetail(e.target.value);
                              set(e.target.value);
                            }}
                            className="w-full h-10 rounded-md bg-white/[0.04] border border-white/10 px-3 text-sm focus:outline-none focus:border-primary/50"
                          >
                            <option value="">Pick a platform…</option>
                            {SOCIAL_SUB_PLATFORMS.map((p) => (
                              <option key={p.value} value={p.value}>
                                {p.label}
                              </option>
                            ))}
                          </select>
                        ),
                      },
                    ]
                  : []),
                {
                  name: "priority",
                  label: "Priority",
                  type: "select",
                  span: "half",
                  defaultValue: "medium",
                  options: [
                    { value: "high", label: "High" },
                    { value: "medium", label: "Medium" },
                    { value: "low", label: "Low" },
                  ],
                },
                { name: "preferredBranch", label: "Preferred branch", type: "text", span: "half", placeholder: "Optional" },
                { name: "email", label: "Email", type: "text", span: "half", placeholder: "kojo@email.com" },
                { name: "phone", label: "Phone", type: "text", span: "half", placeholder: "+233 …" },
                { name: "notes", label: "Notes", type: "textarea", span: "full", placeholder: "What are they looking for?" },
              ]}
              onSubmit={async (values) => {
                const payload = { ...values };
                if (payload.interestedVehicleId != null) {
                  payload.interestedVehicleId = Number(payload.interestedVehicleId);
                  const v = (vehicles ?? []).find(
                    (x) => x.id === payload.interestedVehicleId,
                  );
                  if (v) {
                    const version = v.trim || v.variant;
                    if (version) payload.variant = version;
                    payload.color = v.exteriorColor;
                  }
                }
                const result = await createLead.mutateAsync({
                  data: payload as never,
                });
                queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
                if (result.merged) {
                  toast({
                    title: "Merged into an existing lead",
                    description:
                      result.mergeNotice ??
                      "This enquiry matched an open lead, so it was merged instead of creating a duplicate.",
                  });
                } else {
                  toast({ title: "Lead captured", description: "AURA is scoring and routing this prospect." });
                }
              }}
            />
          </div>
        </div>

        {/* Tab strip with counts */}
        <div className="flex flex-wrap gap-1.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "rounded-full px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors",
                tab === t.key
                  ? "bg-primary text-white"
                  : "bg-foreground/[0.05] text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              <span className="ml-1.5 tabular-nums opacity-70">
                {counts[t.key] ?? 0}
              </span>
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-16 rounded-2xl bg-foreground/[0.04] animate-pulse"
              />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="flex items-center justify-center h-40 rounded-2xl border-2 border-dashed border-border/60 text-muted-foreground/60 text-sm uppercase tracking-widest font-semibold">
            No leads in this view
          </div>
        ) : layout === "list" ? (
          /* List view — dense table */
          <div className="glass-panel rounded-2xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3 font-semibold">Client</th>
                  <th className="px-4 py-3 font-semibold">Model</th>
                  <th className="px-4 py-3 font-semibold">Phase</th>
                  <th className="px-4 py-3 font-semibold">Advisor</th>
                  <th className="px-4 py-3 font-semibold">Contact SLA</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr
                    key={r.lead.id}
                    onClick={() => navigate(`/lead/${r.lead.id}`)}
                    className={cn(
                      "border-b border-white/5 last:border-0 cursor-pointer hover:bg-foreground/[0.04] transition-colors",
                      compact ? "h-11" : "h-14",
                    )}
                  >
                    <td className="px-4 py-2">
                      <div className="font-medium truncate max-w-[200px]">
                        {r.lead.name}
                      </div>
                      {!compact && (
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-0.5">
                          {r.lead.phone && (
                            <span className="inline-flex items-center gap-1">
                              <Phone className="w-3 h-3" />
                              {r.lead.phone}
                            </span>
                          )}
                          {r.lead.email && (
                            <span className="inline-flex items-center gap-1 truncate max-w-[160px]">
                              <Mail className="w-3 h-3" />
                              {r.lead.email}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground truncate max-w-[180px]">
                      {r.model ?? SOURCE_LABEL[r.lead.source] ?? r.lead.source}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {r.stage ? (
                        <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                          {STAGE_LABEL[r.stage]}
                        </span>
                      ) : (
                        <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-foreground/[0.06] px-2 py-0.5 rounded-full">
                          Lost
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground truncate max-w-[150px]">
                      {r.lead.assignedTo || (
                        <span className="text-amber-400">Needs advisor</span>
                      )}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      <SlaChip sla={r.sla} />
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider text-foreground/70 bg-foreground/[0.06] px-2 py-0.5 rounded-full">
                        {STATUS_LABEL[r.lead.status] ?? r.lead.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          /* Card view — compact cards */
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {visible.map((r, i) => (
              <motion.div
                key={r.lead.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i * 0.03, 0.3) }}
                onClick={() => navigate(`/lead/${r.lead.id}`)}
                className="group rounded-2xl border border-white/10 bg-foreground/[0.03] hover:bg-foreground/[0.06] hover:border-primary/30 transition-all duration-300 cursor-pointer p-4"
              >
                <div className="flex items-start gap-3">
                  <div className="shrink-0 w-12 h-12 rounded-xl overflow-hidden bg-foreground/[0.04] flex items-center justify-center">
                    {r.vehicle?.imageUrl ? (
                      <img
                        src={withBase(r.vehicle.imageUrl)}
                        alt={`${r.vehicle.make} ${r.vehicle.model}`}
                        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                      />
                    ) : (
                      <Car className="w-5 h-5 text-muted-foreground/30" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold leading-tight truncate group-hover:text-primary transition-colors">
                      {r.lead.name}
                    </div>
                    <div className="text-xs text-muted-foreground truncate mt-0.5">
                      {r.model ??
                        SOURCE_LABEL[r.lead.source] ??
                        r.lead.source}
                    </div>
                  </div>
                  {r.lead.customerId && (
                    <Link
                      href={`/customers/${r.lead.customerId}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-[10px] font-bold uppercase tracking-wider text-primary inline-flex items-center gap-0.5 hover:underline shrink-0"
                    >
                      Account
                      <ArrowUpRight className="w-3 h-3" />
                    </Link>
                  )}
                </div>

                <div className="flex items-center gap-1.5 flex-wrap mt-3">
                  {r.stage ? (
                    <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                      {STAGE_LABEL[r.stage]}
                    </span>
                  ) : (
                    <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-foreground/[0.06] px-2 py-0.5 rounded-full">
                      Lost
                    </span>
                  )}
                  <span
                    className={cn(
                      "inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full ring-1",
                      PRIORITY_STYLE[r.lead.priority] ?? PRIORITY_STYLE.low,
                    )}
                  >
                    {r.lead.priority}
                  </span>
                  <SlaChip sla={r.sla} />
                </div>

                <div className="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-white/5">
                  <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground truncate">
                    {r.lead.assignedTo ? (
                      <>
                        <UserCheck className="w-3.5 h-3.5" />
                        {r.lead.assignedTo}
                      </>
                    ) : (
                      <span className="text-amber-400 font-semibold uppercase tracking-wider text-[10px]">
                        Needs advisor
                      </span>
                    )}
                  </span>
                  <div className="flex items-center gap-2 text-muted-foreground/70 shrink-0">
                    {r.lead.phone && <Phone className="w-3.5 h-3.5" />}
                    {r.lead.email && <Mail className="w-3.5 h-3.5" />}
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </Page>
    </>
  );
}
