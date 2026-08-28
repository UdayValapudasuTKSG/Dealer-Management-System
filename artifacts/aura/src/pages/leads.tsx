import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  useListDeals,
  useListLeads,
  useListVehicles,
  useCreateLead,
  useListLeadSources,
  getListLeadsQueryKey,
  useListCustomers,
  useCreateCustomer,
  useLinkLeadAccount,
  getListCustomersQueryKey,
  type Lead,
  type LeadInput,
  type ListLeadsParams,
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
  Link2,
  UserPlus,
  Loader2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { motion } from "framer-motion";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { VehicleCascade } from "@/components/vehicle-cascade";
import { VehicleInterestsField } from "@/components/vehicle-interests-field";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useViewMode } from "@/hooks/use-view-mode";
import { Pagination } from "@/components/pagination";
import { ViewControls } from "@/components/view-controls";
import { useAuthz } from "@/lib/auth";
import { SendFeedbackDialog } from "@/components/send-feedback-dialog";
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
  gmail: "Email",
  email: "Email",
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

/** Contact SLA: shared 48h window from createdAt until the lead is contacted. Null once
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
  const [, navigate] = useLocation();
  const searchStr = useSearch();
  const searchParams = new URLSearchParams(searchStr);
  const createdFrom = searchParams.get("from") || "";
  const createdTo = searchParams.get("to") || "";

  const updateDateRange = (from: string, to: string) => {
    const next = new URLSearchParams(searchStr);
    if (from) next.set("from", from);
    else next.delete("from");

    if (to) next.set("to", to);
    else next.delete("to");

    navigate(`~?${next.toString()}`, { replace: true });
  };

  const isInvalidRange = Boolean(createdFrom && createdTo && new Date(createdFrom) > new Date(createdTo));

  const leadQueryParams: ListLeadsParams = {
    createdFrom: createdFrom || undefined,
    createdTo: createdTo || undefined,
  };
  const { data: leads, isLoading } = useListLeads(leadQueryParams, {
    query: {
      queryKey: getListLeadsQueryKey(leadQueryParams),
      enabled: !isInvalidRange,
    },
  });
  const { data: vehicles } = useListVehicles();
  const { data: deals } = useListDeals();
  const { data: leadSources } = useListLeadSources();
  const { data: accounts } = useListCustomers();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createLead = useCreateLead();
  const { me } = useAuthz();
  const { density, setDensity, layout, setLayout } = useViewMode("pipeline");
  const [slaClock, setSlaClock] = useState(() => Date.now());

  // The data query need not refetch just to tick a visual countdown. Rebuild
  // the derived rows once a minute so the displayed value and SLA sort remain
  // accurate while a user keeps the pipeline open.
  useEffect(() => {
    const timer = window.setInterval(() => setSlaClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

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
  const isLeadership =
    !!me && (me.isSuperAdmin || me.roleName === "General Manager");

  // Advisor filter (leadership only) + table sorting (everyone).
  const [advisorFilter, setAdvisorFilter] = useState<string>("all");
  // "__all__" sentinel: a dealer-configured source could legitimately use the
  // code "all", so the unscoped option must not collide with it.
  const [sourceFilter, setSourceFilter] = useState<string>("__all__");
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  // Three-state sort cycle: ascending → descending → off (original order).
  const toggleSort = (key: string) => {
    if (sortKey === key) {
      if (sortDir === "asc") {
        setSortDir("desc");
      } else {
        setSortKey(null);
        setSortDir("asc");
      }
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  // Derive the rail stage for a lead: pre-sale stages map 1:1 from the lead
  // phase; won leads split into Vehicle Allocated / Payment / Pre-Delivery /
  // Delivered by their furthest-along linked deal. Lost leads → null.
  const stageOf = useMemo(() => {
    const rank = (stage: string) =>
      stage === "delivered" ? 3 : stage === "committed" ? 2 : 0;
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
        case "new":
          return "new_lead";
        case "contacted":
          return "contacted";
        case "qualified":
        case "proposal":
          return "engaged";
        case "negotiation":
          return "pre_book";
        case "won": {
          const dealStage =
            dealByLead.get(l.id) ??
            (l.customerId != null
              ? dealByCustomer.get(l.customerId)
              : undefined);
          if (dealStage === "delivered") return "delivered";
          if (dealStage === "committed") return "pre_delivery";
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

  // Enrich every lead once with its stage, macro phase, vehicle, customer
  // location, preferred branch and SLA.
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const customerById = new Map(
      (accounts ?? []).map((customer) => [customer.id, customer]),
    );
    return (leads ?? [])
      .map((lead) => {
        const stage = stageOf(lead);
        const macro = stage ? MACRO_OF[stage] : null;
        const vehicle = vehicles?.find(
          (v) => v.id === lead.interestedVehicleId,
        );
        const model = vehicle
          ? `${vehicle.make} ${vehicle.model}`
          : (lead.selectedModel ?? lead.interestedModelText ?? null);
        const customer =
          lead.customerId != null ? customerById.get(lead.customerId) : null;
        const locationParts = [
          customer?.location,
          customer?.city,
          customer?.country,
        ].reduce<string[]>((parts, value) => {
          const normalized = value?.trim();
          if (
            normalized &&
            !parts.some(
              (part) => part.toLowerCase() === normalized.toLowerCase(),
            )
          ) {
            parts.push(normalized);
          }
          return parts;
        }, []);
        const customerLocation =
          locationParts.join(", ") ||
          customer?.address?.trim() ||
          lead.address?.trim() ||
          null;
        const preferredBranch = lead.preferredBranch?.trim() || null;
        const sla = contactSla(lead);
        return {
          lead,
          stage,
          macro,
          vehicle,
          model,
          customerLocation,
          preferredBranch,
          sla,
        };
      })
      .filter((r) => {
        if (!q) return true;
        const l = r.lead;
        return (
          l.name.toLowerCase().includes(q) ||
          (r.model ?? "").toLowerCase().includes(q) ||
          (r.customerLocation ?? "").toLowerCase().includes(q) ||
          (r.preferredBranch ?? "").toLowerCase().includes(q) ||
          (l.phone ?? "").toLowerCase().includes(q) ||
          (l.email ?? "").toLowerCase().includes(q) ||
          (l.assignedTo ?? "").toLowerCase().includes(q)
        );
      });
  }, [leads, vehicles, accounts, stageOf, search, slaClock]);

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

  const advisorOptions = useMemo(
    () =>
      Array.from(
        new Set(
          (leads ?? [])
            .map((l) => (l.assignedTo ?? "").trim())
            .filter((a) => a.length > 0),
        ),
      ).sort((a, b) => a.localeCompare(b)),
    [leads],
  );

  // Source options: configured lead sources plus any legacy/ad-hoc codes
  // still present on leads, so no lead is ever unfilterable.
  const sourceOptions = useMemo(() => {
    const byCode = new Map<string, string>();
    for (const s of leadSources ?? []) byCode.set(s.code, s.name);
    for (const l of leads ?? []) {
      const code = (l.source ?? "").trim();
      if (code && !byCode.has(code))
        byCode.set(code, SOURCE_LABEL[code] ?? code);
    }
    return Array.from(byCode, ([code, label]) => ({ code, label })).sort(
      (a, b) => a.label.localeCompare(b.label),
    );
  }, [leadSources, leads]);

  const visible = useMemo(() => {
    return rows.filter((r) => {
      if (sourceFilter !== "__all__" && r.lead.source !== sourceFilter)
        return false;
      if (
        advisorFilter !== "all" &&
        (r.lead.assignedTo ?? "").trim() !== advisorFilter
      )
        return false;
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
  }, [rows, tab, myId, myName, advisorFilter, sourceFilter]);

  const PAGE_SIZE = layout === "list" ? 25 : compact ? 30 : 24;
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [tab, search, layout, density, advisorFilter, sourceFilter]);
  const sortedVisible = useMemo(() => {
    if (!sortKey) return visible;
    const dir = sortDir === "asc" ? 1 : -1;
    const stageOrder: readonly string[] = STAGES;
    const val = (
      r: (typeof visible)[number],
    ): string | number | null => {
      switch (sortKey) {
        case "client": return r.lead.name.toLowerCase();
        case "model": return r.model?.toLowerCase() ?? null;
        case "location": return r.customerLocation?.toLowerCase() ?? null;
        case "branch": return r.preferredBranch?.toLowerCase() ?? null;
        case "phase": {
          if (!r.stage) return stageOrder.length; // Lost sorts last
          const idx = stageOrder.indexOf(r.stage);
          return idx === -1 ? stageOrder.length : idx;
        }
        case "advisor": return (r.lead.assignedTo ?? "").toLowerCase();
        case "sla":
          // Contacted (no SLA) sorts last; overdue first when ascending.
          return r.sla ? r.sla.left : Number.MAX_SAFE_INTEGER;
        default: return 0;
      }
    };
    return [...visible].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      const aEmpty = av == null || av === "";
      const bEmpty = bv == null || bv === "";
      if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
      if (av == null || bv == null) return 0;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [visible, sortKey, sortDir]);
  const pageCount = Math.max(1, Math.ceil(sortedVisible.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const paged = useMemo(
    () => sortedVisible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [sortedVisible, safePage, PAGE_SIZE],
  );

  // GM bulk feedback-form selection: checkboxes on the list view plus a
  // "select all filtered" that spans every result page (not just the visible
  // one). The send dialog can also target all_matching via server filters.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [sendFeedbackOpen, setSendFeedbackOpen] = useState(false);
  const toggleSelected = (id: number) =>
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const pageIds = paged.map((r) => r.lead.id);
  const allPageSelected =
    pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const togglePage = () =>
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (allPageSelected) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  const selectAllFiltered = () =>
    setSelectedIds(new Set(sortedVisible.map((r) => r.lead.id)));

  // Link-account dialog: pick an existing account or create one from the lead.
  const [linkTarget, setLinkTarget] = useState<Lead | null>(null);
  const [accountSearch, setAccountSearch] = useState("");
  const linkAccount = useLinkLeadAccount();
  const createCustomer = useCreateCustomer();
  const linkBusy = linkAccount.isPending || createCustomer.isPending;

  const matchedAccounts = useMemo(() => {
    const list = accounts ?? [];
    const q = accountSearch.trim().toLowerCase();
    const filtered = q
      ? list.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            (c.email ?? "").toLowerCase().includes(q) ||
            (c.phone ?? "").replace(/\D/g, "").includes(q.replace(/\D/g, "") || "\u0000"),
        )
      : list;
    return filtered.slice(0, 8);
  }, [accounts, accountSearch]);

  const finishLink = async (leadId: number, customerId: number, name: string) => {
    try {
      await linkAccount.mutateAsync({ id: leadId, data: { customerId } });
      await queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      toast({ title: "Account linked", description: `Lead linked to ${name}.` });
      setLinkTarget(null);
      setAccountSearch("");
    } catch (e) {
      toast({
        title: "Could not link account",
        description: e instanceof Error ? e.message : "Unexpected error",
        variant: "destructive",
      });
    }
  };

  const createAndLink = async (lead: Lead) => {
    try {
      const customer = await createCustomer.mutateAsync({
        data: {
          name: lead.name,
          email: lead.email || undefined,
          phone: lead.phone || undefined,
          accountType: "person",
        },
      });
      await queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
      await finishLink(lead.id, customer.id, customer.name);
    } catch (e: unknown) {
      // Duplicate email/phone → the API returns the existing account id in
      // the ApiError payload (error.data.existingId); link that account.
      const existingId = (e as { data?: { existingId?: number } | null })?.data
        ?.existingId;
      if (existingId) {
        await finishLink(lead.id, existingId, "the existing matching account");
        return;
      }
      toast({
        title: "Could not create account",
        description: e instanceof Error ? e.message : "Unexpected error",
        variant: "destructive",
      });
    }
  };

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

  const heroActions = (
    <div className="flex items-center gap-3">
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
                <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-4 h-9 text-sm shadow-md shadow-primary/20 gap-1.5 font-medium tracking-wide">
                  <Plus className="w-4 h-4" />
                  New Lead
                </Button>
              }
              fields={[
                { name: "name", label: "Name", type: "text", required: true, span: "full", placeholder: "Kojo Asante", section: "Prospect" },
                { name: "phone", label: "Phone", type: "phone", required: true, span: "half", placeholder: "+592", section: "Prospect" },
                { name: "email", label: "Email", type: "email", required: true, span: "half", placeholder: "kojo@email.com", section: "Prospect" },
                { name: "address", label: "Address", type: "text", required: true, span: "full", placeholder: "Lot 12 Main Street, Georgetown", section: "Prospect" },
                {
                  name: "source",
                  label: "Lead source",
                  type: "select",
                  required: true,
                  span: "half",
                  section: "Enquiry",
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
                        section: "Enquiry",
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
                  name: "vehicleInterests",
                  label: "Interested vehicles",
                  type: "custom",
                  required: true,
                  span: "full",
                  section: "Enquiry",
                  render: (value, set) => (
                    <VehicleInterestsField
                      value={value}
                      onChange={set}
                      vehicles={vehicles ?? []}
                    />
                  ),
                },
                {
                  name: "isRetailCustomer",
                  label: "Retail customer",
                  type: "custom",
                  span: "half",
                  section: "Enquiry",
                  render: (value, set) => (
                    <label className="flex items-center gap-2.5 h-10 px-3 rounded-md bg-white/[0.04] border border-white/10 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={value === "true"}
                        onChange={(e) => set(e.target.checked ? "true" : "")}
                        className="w-4 h-4 accent-[var(--primary)] rounded"
                      />
                      <span className="text-sm">Is a retail customer</span>
                    </label>
                  ),
                },
                {
                  name: "priority",
                  label: "Priority (optional)",
                  type: "select",
                  required: false,
                  span: "half",
                  section: "Enquiry",
                  defaultValue: "medium",
                  options: [
                    { value: "high", label: "High" },
                    { value: "medium", label: "Medium" },
                    { value: "low", label: "Low" },
                  ],
                },
                { name: "notes", label: "Notes", type: "textarea", span: "full", placeholder: "Optional — what are they looking for?", section: "Details" },
              ]}
              onSubmit={async (values) => {
                const payload = { ...values };
                // The channel is implied by the lead source rather than asked
                // twice: social sources → social, walk-in → walkin, else web.
                payload.channel = selectedSourceCfg?.isSocial
                  ? "social"
                  : ["walk_in", "walkin"].includes(String(payload.source))
                    ? "walkin"
                    : "web";
                payload.isRetailCustomer = payload.isRetailCustomer === "true";
                if (payload.vehicleInterests) {
                  try {
                    const parsedInterests = JSON.parse(payload.vehicleInterests as string);
                    payload.vehicleInterests = parsedInterests;

                    if (parsedInterests.length > 0 && parsedInterests[0].vehicleId != null) {
                      const firstVehicleId = parsedInterests[0].vehicleId;
                      const v = (vehicles ?? []).find((x) => x.id === firstVehicleId);
                      if (v) {
                        const version = v.trim || v.variant;
                        if (version) payload.variant = version;
                        if (v.exteriorColor) payload.color = v.exteriorColor;
                        payload.selectedModel = [v.make, v.model, version]
                          .filter(Boolean)
                          .join(" ");
                      }
                    }
                  } catch {
                    delete payload.vehicleInterests;
                  }
                }
                const result = await createLead.mutateAsync({
                  data: payload as unknown as LeadInput,
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
  );

  return (
    <>
      <PageHero
        eyebrow="Sales"
        title="Pipeline"
        subtitle="Every lead, from first enquiry to delivery."
        className="pb-3"
        action={heroActions}
      />
      <Page className="space-y-3 pt-0">
        {/* Command row: search + phase tabs on one line */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full sm:w-[280px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search name, model, location, branch, phone or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-9 rounded-full bg-foreground/[0.04] border border-white/10 pl-9 pr-4 text-sm focus:outline-none focus:border-primary/50"
            />
          </div>
          {sourceOptions.length > 0 && (
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="h-9 rounded-full bg-foreground/[0.04] border border-white/10 text-sm px-3 pr-8 text-foreground/90 focus:outline-none focus:border-primary/50"
              aria-label="Filter by lead source"
            >
              <option value="__all__">All sources</option>
              {sourceOptions.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.label}
                </option>
              ))}
            </select>
          )}
          {isLeadership && advisorOptions.length > 0 && (
            <select
              value={advisorFilter}
              onChange={(e) => setAdvisorFilter(e.target.value)}
              className="h-9 rounded-full bg-foreground/[0.04] border border-white/10 text-sm px-3 pr-8 text-foreground/90 focus:outline-none focus:border-primary/50"
              aria-label="Filter by sales advisor"
            >
              <option value="all">All advisors</option>
              {advisorOptions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          )}
          <div className={cn("flex items-center h-9 px-3 gap-2 rounded-full border text-sm", isInvalidRange ? "border-red-500/50 bg-red-500/5" : "border-white/10 bg-foreground/[0.04]")}>
            <span className="text-muted-foreground text-[10px] uppercase tracking-wider font-semibold">Created</span>
            <input
              type="date"
              value={createdFrom}
              onChange={(e) => updateDateRange(e.target.value, createdTo)}
              className="bg-transparent border-none focus:outline-none text-foreground/90 w-auto min-w-[110px]"
            />
            <span className="text-muted-foreground text-xs">to</span>
            <input
              type="date"
              value={createdTo}
              onChange={(e) => updateDateRange(createdFrom, e.target.value)}
              className="bg-transparent border-none focus:outline-none text-foreground/90 w-auto min-w-[110px]"
            />
            {isInvalidRange && <span className="text-red-400 text-[10px] uppercase font-bold ml-1">Invalid</span>}
            {(createdFrom || createdTo) && (
               <button
                 onClick={() => updateDateRange("", "")}
                 className="ml-1 text-muted-foreground hover:text-foreground text-lg leading-none p-0.5 rounded-full h-4 w-4 flex items-center justify-center -translate-y-px"
                 title="Clear dates"
                 type="button"
               >
                 <span className="sr-only">Clear dates</span>
                 &times;
               </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-wider transition-colors",
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
        </div>

        {isLeadership && selectedIds.size > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-primary/30 bg-primary/[0.07] px-4 py-2.5">
            <span className="text-sm font-semibold">
              {selectedIds.size} lead{selectedIds.size === 1 ? "" : "s"} selected
            </span>
            {selectedIds.size < sortedVisible.length && (
              <button
                type="button"
                onClick={selectAllFiltered}
                className="text-xs font-semibold text-primary hover:underline"
              >
                Select all {sortedVisible.length} filtered leads
              </button>
            )}
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Clear selection
            </button>
            <div className="flex-1" />
            <Button
              size="sm"
              onClick={() => setSendFeedbackOpen(true)}
              className="rounded-full h-8 text-xs bg-primary hover:bg-primary/90"
            >
              Send Feedback Form
            </Button>
          </div>
        )}
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
                  {isLeadership && (
                    <th className="pl-4 pr-1 py-3 w-8">
                      <input
                        type="checkbox"
                        aria-label="Select all leads on this page"
                        checked={allPageSelected}
                        onChange={togglePage}
                        className="w-4 h-4 accent-[var(--primary)] cursor-pointer align-middle"
                      />
                    </th>
                  )}
                  {(
                    [
                      ["Client", "client"],
                      ["Model", "model"],
                      ["Customer location", "location"],
                      ["Preferred branch", "branch"],
                      ["Phase", "phase"],
                      ["Advisor", "advisor"],
                      ["Contact SLA", "sla"],
                    ] as const
                  ).map(([label, k]) => (
                    <th key={k} className="px-4 py-3 font-semibold">
                      <button
                        onClick={() => toggleSort(k)}
                        className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-foreground transition-colors"
                      >
                        {label}
                        <span className="text-[9px] leading-none">
                          {sortKey === k ? (sortDir === "asc" ? "▲" : "▼") : ""}
                        </span>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paged.map((r) => (
                  <tr
                    key={r.lead.id}
                    onClick={() => navigate(`/lead/${r.lead.id}`)}
                    className={cn(
                      "border-b border-white/5 last:border-0 cursor-pointer hover:bg-foreground/[0.04] transition-colors",
                      compact ? "h-11" : "h-14",
                    )}
                  >
                    {isLeadership && (
                      <td
                        className="pl-4 pr-1 py-2 w-8"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.lead.name}`}
                          checked={selectedIds.has(r.lead.id)}
                          onChange={() => toggleSelected(r.lead.id)}
                          className="w-4 h-4 accent-[var(--primary)] cursor-pointer align-middle"
                        />
                      </td>
                    )}
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
                      {r.model ?? "—"}
                    </td>
                    <td
                      className="px-4 py-2 text-muted-foreground truncate max-w-[190px]"
                      title={r.customerLocation ?? "No customer location"}
                    >
                      {r.customerLocation ?? (
                        <span className="text-muted-foreground/50">Not provided</span>
                      )}
                    </td>
                    <td
                      className="px-4 py-2 text-muted-foreground truncate max-w-[160px]"
                      title={r.preferredBranch ?? "No preferred branch"}
                    >
                      {r.preferredBranch ?? (
                        <span className="text-muted-foreground/50">Not provided</span>
                      )}
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
                      <div className="flex items-center gap-2">
                        <SlaChip sla={r.sla} />
                        {!r.lead.customerId && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setLinkTarget(r.lead);
                            }}
                            className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-primary inline-flex items-center gap-0.5 transition-colors"
                            title="Link or create a customer account"
                          >
                            <Link2 className="w-3 h-3" />
                            Link
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          /* Card view — compact cards */
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {paged.map((r, i) => (
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
                      {r.model ?? SOURCE_LABEL[r.lead.source] ?? r.lead.source}
                    </div>
                  </div>
                  {r.lead.customerId ? (
                    <Link
                      href={`/customers/${r.lead.customerId}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-[10px] font-bold uppercase tracking-wider text-primary inline-flex items-center gap-0.5 hover:underline shrink-0"
                    >
                      Account
                      <ArrowUpRight className="w-3 h-3" />
                    </Link>
                  ) : me?.roleName === "Sales Advisor" && !isMine(r.lead) ? null : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setLinkTarget(r.lead);
                      }}
                      className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-primary inline-flex items-center gap-0.5 shrink-0 transition-colors"
                      title="Link or create a customer account"
                    >
                      <Link2 className="w-3 h-3" />
                      Link account
                    </button>
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

        {!isLoading && visible.length > 0 && (
          <>
            {visible.length > PAGE_SIZE && (
              <div className="text-center text-xs text-muted-foreground tabular-nums">
                Showing {(safePage - 1) * PAGE_SIZE + 1}–
                {Math.min(safePage * PAGE_SIZE, visible.length)} of{" "}
                {visible.length}
              </div>
            )}
            <Pagination
              page={safePage}
              pageCount={pageCount}
              onPageChange={(p) => {
                setPage(p);
                document
                  .querySelector("main, [data-page-scroll]")
                  ?.scrollTo({ top: 0 });
                window.scrollTo({ top: 0 });
              }}
            />
          </>
        )}
        <Dialog
          open={linkTarget != null}
          onOpenChange={(open) => {
            if (!open) {
              setLinkTarget(null);
              setAccountSearch("");
            }
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Link customer account</DialogTitle>
              <DialogDescription>
                {linkTarget
                  ? `Attach ${linkTarget.name} to an existing account, or open a new one from their details.`
                  : ""}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={accountSearch}
                  onChange={(e) => setAccountSearch(e.target.value)}
                  placeholder="Search accounts by name, email or phone"
                  className="pl-9"
                />
              </div>
              <div className="max-h-64 overflow-y-auto space-y-1">
                {matchedAccounts.length === 0 ? (
                  <p className="text-sm text-muted-foreground px-1 py-3">
                    No matching accounts.
                  </p>
                ) : (
                  matchedAccounts.map((c) => (
                    <button
                      key={c.id}
                      disabled={linkBusy}
                      onClick={() =>
                        linkTarget && finishLink(linkTarget.id, c.id, c.name)
                      }
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-foreground/[0.06] transition-colors disabled:opacity-50"
                    >
                      <div className="font-medium text-sm">{c.name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {[c.email, c.phone].filter(Boolean).join(" · ") ||
                          "No contact details"}
                      </div>
                    </button>
                  ))
                )}
              </div>
              <div className="pt-2 border-t border-white/10">
                <Button
                  variant="outline"
                  disabled={linkBusy || !linkTarget}
                  onClick={() => linkTarget && createAndLink(linkTarget)}
                  className="w-full gap-2"
                >
                  {linkBusy ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <UserPlus className="w-4 h-4" />
                  )}
                  Create a new account from this lead
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </Page>
      {sendFeedbackOpen && (
        <SendFeedbackDialog
          open={sendFeedbackOpen}
          onClose={() => setSendFeedbackOpen(false)}
          selectedLeadIds={[...selectedIds]}
        />
      )}
    </>
  );
}
