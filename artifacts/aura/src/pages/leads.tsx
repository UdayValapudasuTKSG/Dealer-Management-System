import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  useListDeals,
  useListLeads,
  useListVehicles,
  useCreateLead,
  useGetPipelineSuggestions,
  getListLeadsQueryKey,
} from "@workspace/api-client-react";
import type { GetPipelineSuggestionsPhase } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Plus,
  Phone,
  Mail,
  ArrowUpRight,
  Car,
  Sparkles,
  Zap,
  AlertCircle,
  RefreshCw,
  Loader2,
  ChevronRight,
  Check,
  Clock,
  UserCheck,
  Search,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Page } from "@/components/layout/page";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { VehicleCascade } from "@/components/vehicle-cascade";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useViewMode } from "@/hooks/use-view-mode";
import { ViewControls } from "@/components/view-controls";
import { ActionQueue } from "@/components/action-queue";

const STAGES = [
  "new_lead",
  "qualified",
  "test_drive",
  "desking",
  "sold",
  "in_prep",
  "delivered",
] as const;
type Stage = (typeof STAGES)[number];

const STAGE_LABEL: Record<Stage, string> = {
  new_lead: "New Lead",
  qualified: "Qualified",
  test_drive: "Test Drive",
  desking: "Negotiation",
  sold: "Sold",
  in_prep: "Pre-Delivery",
  delivered: "Delivered",
};

const STAGE_CAPTION: Record<Stage, string> = {
  new_lead: "Fresh interest, awaiting first contact",
  qualified: "Vetted buyers, matching inventory",
  test_drive: "Test drives and showroom visits",
  desking: "Structuring terms and negotiating",
  sold: "Deal agreed, paperwork in motion",
  in_prep: "Vehicle in prep and pre-delivery",
  delivered: "Keys handed over, onboarding retention",
};

// Rail stage → underlying lead phase (drives AURA suggestions)
const STAGE_PHASE: Record<Stage, GetPipelineSuggestionsPhase> = {
  new_lead: "aware",
  qualified: "consider",
  test_drive: "engage",
  desking: "negotiate",
  sold: "won",
  in_prep: "won",
  delivered: "won",
};

const PRIORITY_STYLE: Record<string, string> = {
  high: "bg-primary/15 text-primary ring-primary/30",
  medium: "bg-amber-500/15 text-amber-400 ring-amber-500/30",
  low: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30",
};

const SOURCE_LABEL: Record<string, string> = {
  website: "Website",
  walk_in: "Walk-in",
  phone: "Phone",
  facebook: "Facebook",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
  referral: "Referral",
};

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

const NEXT_ACTION: Record<Stage, string> = {
  new_lead: "Make first contact",
  qualified: "Book a test drive",
  test_drive: "Run the drive, capture feedback",
  desking: "Finalize numbers & deposit",
  sold: "Complete paperwork",
  in_prep: "Prep vehicle for delivery",
  delivered: "Follow up & retain",
};

const withBase = (url: string) =>
  `${import.meta.env.BASE_URL}${url.replace(/^\//, "")}`;

function daysInStage(lead: { stageEnteredAt?: string | null; createdAt: string }) {
  const since = lead.stageEnteredAt ?? lead.createdAt;
  const ms = Date.now() - new Date(since).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

export default function Leads() {
  const { data: leads, isLoading } = useListLeads();
  const { data: vehicles } = useListVehicles();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createLead = useCreateLead();
  const { density, setDensity, layout, setLayout } = useViewMode("pipeline");

  const { data: deals } = useListDeals();

  // Derive the rail stage for a lead: pre-sale stages map 1:1 from the lead
  // phase; won leads split into Sold / Pre-Delivery / Delivered by deal stage.
  const stageOf = useMemo(() => {
    const rank = (stage: string) =>
      stage === "delivered" ? 2 : stage === "committed" ? 1 : 0;
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
    return (l: { id: number; phase: string; customerId?: number | null }): Stage | null => {
      switch (l.phase) {
        case "aware":
          return "new_lead";
        case "consider":
          return "qualified";
        case "engage":
          return "test_drive";
        case "negotiate":
          return "desking";
        case "won": {
          const dealStage =
            dealByLead.get(l.id) ??
            (l.customerId != null ? dealByCustomer.get(l.customerId) : undefined);
          if (dealStage === "delivered") return "delivered";
          if (dealStage === "committed") return "in_prep";
          return "sold";
        }
        default:
          return null; // lost — not shown on the rail
      }
    };
  }, [deals]);

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const s of STAGES) map[s] = 0;
    for (const l of leads ?? []) {
      const s = stageOf(l);
      if (s) map[s] += 1;
    }
    return map;
  }, [leads, stageOf]);

  const [selectedStage, setSelectedStage] = useState<Stage>("test_drive");
  const [, navigate] = useLocation();

  const stageLeads = (leads ?? []).filter((l) => stageOf(l) === selectedStage);

  // Full-pipeline table (list layout): search, stage filter, sortable columns.
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState<"all" | Stage>("all");
  const [sort, setSort] = useState<{
    key: "name" | "stage" | "owner" | "value" | "days" | "ai";
    dir: "asc" | "desc";
  }>({ key: "days", dir: "desc" });

  const dealValueByLead = useMemo(() => {
    const map = new Map<number, number>();
    for (const d of deals ?? []) {
      if (d.leadId != null) {
        const v = d.otdPrice || d.vehiclePrice - d.discount;
        const prev = map.get(d.leadId);
        if (prev === undefined || v > prev) map.set(d.leadId, v);
      }
    }
    return map;
  }, [deals]);

  const tableRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = (leads ?? [])
      .map((lead) => {
        const stage = stageOf(lead);
        if (!stage) return null;
        const vehicle = vehicles?.find((v) => v.id === lead.interestedVehicleId);
        const value =
          dealValueByLead.get(lead.id) ?? (vehicle ? vehicle.price : null);
        return { lead, stage, vehicle, value, days: daysInStage(lead) };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .filter((r) => stageFilter === "all" || r.stage === stageFilter)
      .filter(
        (r) =>
          !q ||
          r.lead.name.toLowerCase().includes(q) ||
          (r.lead.assignedTo ?? "").toLowerCase().includes(q) ||
          (r.vehicle
            ? `${r.vehicle.make} ${r.vehicle.model}`.toLowerCase().includes(q)
            : false),
      );
    const dir = sort.dir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      switch (sort.key) {
        case "name":
          return a.lead.name.localeCompare(b.lead.name) * dir;
        case "stage":
          return (STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage)) * dir;
        case "owner":
          return (a.lead.assignedTo ?? "").localeCompare(b.lead.assignedTo ?? "") * dir;
        case "value":
          return ((a.value ?? 0) - (b.value ?? 0)) * dir;
        case "days":
          return (a.days - b.days) * dir;
        case "ai":
          return (a.lead.aiScore - b.lead.aiScore) * dir;
      }
    });
    return rows;
  }, [leads, vehicles, stageOf, dealValueByLead, search, stageFilter, sort]);

  const suggestions = useGetPipelineSuggestions({
    phase: STAGE_PHASE[selectedStage],
  });

  const compact = density === "compact";

  return (
    <Page className="space-y-5">
      {/* Compact command row: view controls + primary action. */}
      <div className="flex flex-wrap items-center justify-end gap-3">
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
                options: Object.entries(SOURCE_LABEL).map(([value, label]) => ({
                  value,
                  label,
                })),
              },
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
              await createLead.mutateAsync({ data: payload as never });
              queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
              toast({ title: "Lead captured", description: "AURA is scoring and routing this prospect." });
            }}
          />
      </div>

      <ActionQueue />

      {layout === "list" ? (
        /* Full-pipeline table: every non-lost lead, searchable + stage filter */
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[220px] max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search client, vehicle or advisor…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-full bg-foreground/[0.04] border border-white/10 pl-9 pr-4 py-2 text-sm focus:outline-none focus:border-primary/50"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setStageFilter("all")}
                className={cn(
                  "rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors",
                  stageFilter === "all"
                    ? "bg-primary text-white"
                    : "bg-foreground/[0.05] text-muted-foreground hover:text-foreground",
                )}
              >
                All
              </button>
              {STAGES.map((s) => (
                <button
                  key={s}
                  onClick={() => setStageFilter(s)}
                  className={cn(
                    "rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors",
                    stageFilter === s
                      ? "bg-primary text-white"
                      : "bg-foreground/[0.05] text-muted-foreground hover:text-foreground",
                  )}
                >
                  {STAGE_LABEL[s]}
                  <span className="ml-1.5 tabular-nums opacity-70">{counts[s] ?? 0}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="glass-panel rounded-2xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                  {(
                    [
                      ["name", "Client"],
                      ["stage", "Stage"],
                      ["owner", "Owner"],
                      ["value", "Value"],
                      ["days", "Days in stage"],
                      ["ai", "AI"],
                    ] as const
                  ).map(([key, label]) => (
                    <th
                      key={key}
                      onClick={() =>
                        setSort((prev) =>
                          prev.key === key
                            ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
                            : { key, dir: "asc" },
                        )
                      }
                      className={cn(
                        "px-4 py-3 font-semibold cursor-pointer select-none hover:text-foreground whitespace-nowrap",
                        (key === "value" || key === "days" || key === "ai") && "text-right",
                      )}
                    >
                      {label}
                      {sort.key === key && (sort.dir === "asc" ? " ↑" : " ↓")}
                    </th>
                  ))}
                  <th className="px-4 py-3 font-semibold">Next action</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground text-sm">
                      No leads match this view
                    </td>
                  </tr>
                ) : (
                  tableRows.map((row) => (
                    <tr
                      key={row.lead.id}
                      onClick={() => navigate(`/lead/${row.lead.id}`)}
                      className={cn(
                        "border-b border-white/5 last:border-0 cursor-pointer hover:bg-foreground/[0.04] transition-colors",
                        compact ? "h-10" : "h-12",
                      )}
                    >
                      <td className="px-4 py-2">
                        <div className="font-medium truncate max-w-[200px]">{row.lead.name}</div>
                        {!compact && (
                          <div className="text-[11px] text-muted-foreground truncate max-w-[220px]">
                            {row.vehicle ? `${row.vehicle.make} ${row.vehicle.model}` : SOURCE_LABEL[row.lead.source] ?? row.lead.source}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                          {STAGE_LABEL[row.stage]}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-muted-foreground truncate max-w-[150px]">
                        {row.lead.assignedTo || <span className="text-amber-400">Needs advisor</span>}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">
                        {row.value != null
                          ? row.value.toLocaleString("en-US", {
                              style: "currency",
                              currency: "USD",
                              maximumFractionDigits: 0,
                            })
                          : "—"}
                      </td>
                      <td
                        className={cn(
                          "px-4 py-2 text-right tabular-nums",
                          row.days >= 7 ? "text-amber-400 font-semibold" : "text-muted-foreground",
                        )}
                      >
                        {row.days}d
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium text-primary">
                        {row.lead.aiScore}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {NEXT_ACTION[row.stage]}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <>
      {/* Stage rail — slim chevron strip */}
      <div className="flex overflow-x-auto rounded-2xl border border-white/10 bg-foreground/[0.03] p-1.5 gap-0.5">
        {STAGES.map((stage, i) => {
          const isActive = stage === selectedStage;
          return (
            <button
              key={stage}
              onClick={() => setSelectedStage(stage)}
              style={{
                clipPath:
                  i === 0
                    ? "polygon(0 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 0 100%)"
                    : i === STAGES.length - 1
                      ? "polygon(0 0, 100% 0, 100% 100%, 0 100%, 10px 50%)"
                      : "polygon(0 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 0 100%, 10px 50%)",
              }}
              className={cn(
                "relative flex-1 min-w-[110px] flex items-center justify-center gap-2 py-2.5 pl-4 pr-3 text-[11px] font-semibold uppercase tracking-wider transition-colors",
                isActive
                  ? "bg-gradient-to-r from-primary to-blue-800 text-white"
                  : "bg-foreground/[0.05] text-muted-foreground hover:bg-foreground/[0.09] hover:text-foreground",
              )}
            >
              <span className="truncate">{STAGE_LABEL[stage]}</span>
              <span
                className={cn(
                  "shrink-0 rounded-full px-1.5 py-px text-[10px] font-bold tabular-nums",
                  isActive ? "bg-white/20 text-white" : "bg-foreground/[0.08]",
                )}
              >
                {counts[stage] ?? 0}
              </span>
            </button>
          );
        })}
      </div>

      {/* Detail — animated per stage */}
      <AnimatePresence mode="wait">
        <motion.div
          key={selectedStage}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.3 }}
          className="grid grid-cols-1 lg:grid-cols-5 gap-6"
        >
          {/* Leads in stage */}
          <div className="lg:col-span-3 space-y-4">
            <div className="flex items-baseline justify-between">
              <div>
                <h2 className="text-2xl font-light tracking-tight">
                  {STAGE_LABEL[selectedStage]}
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {STAGE_CAPTION[selectedStage]}
                </p>
              </div>
              <span className="text-sm font-semibold text-primary shrink-0">
                {stageLeads.length} client{stageLeads.length === 1 ? "" : "s"}
              </span>
            </div>

            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-20 rounded-2xl bg-foreground/[0.04] animate-pulse"
                  />
                ))}
              </div>
            ) : stageLeads.length === 0 ? (
              <div className="flex items-center justify-center h-32 rounded-2xl border-2 border-dashed border-border/60 text-muted-foreground/60 text-sm uppercase tracking-widest font-semibold">
                No clients in this stage
              </div>
            ) : (
              <div className="space-y-3">
                {stageLeads.map((lead, i) => {
                  const vehicle = vehicles?.find(
                    (v) => v.id === lead.interestedVehicleId,
                  );
                  const days = daysInStage(lead);
                  return (
                    <motion.div
                      key={lead.id}
                      initial={{ opacity: 0, x: -12 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: Math.min(i * 0.04, 0.4) }}
                      onClick={() => navigate(`/lead/${lead.id}`)}
                      className={cn(
                        "group flex items-center gap-4 rounded-2xl border border-white/10 bg-foreground/[0.03] hover:bg-foreground/[0.06] hover:border-primary/30 transition-all duration-300 cursor-pointer",
                        compact ? "p-2.5 pr-3" : "p-3 pr-4",
                      )}
                    >
                      <div
                        className={cn(
                          "shrink-0 rounded-xl overflow-hidden bg-foreground/[0.04] flex items-center justify-center",
                          compact ? "w-12 h-12" : "w-16 h-16",
                        )}
                      >
                        {vehicle?.imageUrl ? (
                          <img
                            src={withBase(vehicle.imageUrl)}
                            alt={`${vehicle.make} ${vehicle.model}`}
                            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                          />
                        ) : (
                          <Car className="w-6 h-6 text-muted-foreground/30" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-semibold text-base leading-tight truncate group-hover:text-primary transition-colors">
                            {lead.name}
                          </span>
                          {vehicle && (
                            <span className="text-xs text-muted-foreground truncate hidden sm:inline">
                              · {vehicle.make} {vehicle.model}
                            </span>
                          )}
                        </div>
                        <div className={cn("flex items-center gap-2 flex-wrap", compact ? "mt-1" : "mt-2")}>
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                            {SOURCE_LABEL[lead.source] ?? lead.source}
                          </span>
                          <span
                            className={cn(
                              "inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full ring-1",
                              PRIORITY_STYLE[lead.priority] ?? PRIORITY_STYLE.low,
                            )}
                          >
                            {lead.priority}
                          </span>
                          {!compact && (
                            <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider text-foreground/70 bg-foreground/[0.06] px-2 py-0.5 rounded-full">
                              {STATUS_LABEL[lead.status] ?? lead.status}
                            </span>
                          )}
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full",
                              days >= 7
                                ? "text-amber-400 bg-amber-500/10"
                                : "text-muted-foreground bg-foreground/[0.05]",
                            )}
                          >
                            <Clock className="w-3 h-3" />
                            {days}d in stage
                          </span>
                          {lead.assignedTo ? (
                            !compact && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-foreground/[0.05] px-2 py-0.5 rounded-full">
                                <UserCheck className="w-3 h-3" />
                                {lead.assignedTo}
                              </span>
                            )
                          ) : (
                            <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full">
                              Needs advisor
                            </span>
                          )}
                          {lead.email && (
                            <Mail className="w-3.5 h-3.5 text-muted-foreground/70" />
                          )}
                          {lead.phone && (
                            <Phone className="w-3.5 h-3.5 text-muted-foreground/70" />
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <div className="text-right hidden sm:block">
                          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
                            AI Score
                          </div>
                          <div className={cn("font-light text-primary", compact ? "text-base" : "text-lg")}>
                            {lead.aiScore}
                          </div>
                        </div>
                        {lead.customerId && (
                          <Link
                            href={`/customers/${lead.customerId}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-[10px] font-bold uppercase tracking-wider text-primary inline-flex items-center gap-0.5 hover:underline"
                          >
                            Account
                            <ArrowUpRight className="w-3 h-3" />
                          </Link>
                        )}
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </div>

          {/* AURA suggestions */}
          <div className="lg:col-span-2">
            <div className="sticky top-4 rounded-3xl border border-primary/20 bg-gradient-to-b from-primary/[0.06] to-foreground/[0.02] shadow-[0_18px_48px_-28px_rgba(0,0,0,0.6)] overflow-hidden">
              <div className="flex items-center gap-3 px-5 py-4 border-b border-white/10">
                <span className="relative w-9 h-9 rounded-full bg-primary/15 flex items-center justify-center">
                  <Sparkles className="w-4 h-4 text-primary" />
                  {suggestions.isFetching && (
                    <span className="absolute inset-0 rounded-full ring-2 ring-primary/40 animate-ping" />
                  )}
                </span>
                <div>
                  <div className="text-sm font-semibold tracking-tight">
                    AURA recommends
                  </div>
                  <div className="text-[10px] uppercase tracking-widest text-primary">
                    {suggestions.isFetching ? "Reading the stage…" : "Live"}
                  </div>
                </div>
              </div>

              <div className="p-5 space-y-4">
                {suggestions.isLoading ? (
                  <div className="flex items-center gap-3 text-muted-foreground text-sm py-8 justify-center">
                    <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    Thinking through {STAGE_LABEL[selectedStage].toLowerCase()}…
                  </div>
                ) : suggestions.isError ? (
                  <div className="text-center py-8 space-y-3">
                    <AlertCircle className="w-6 h-6 text-muted-foreground/50 mx-auto" />
                    <p className="text-sm text-muted-foreground">
                      The concierge is unavailable right now.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => suggestions.refetch()}
                      className="rounded-full gap-2"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Retry
                    </Button>
                  </div>
                ) : suggestions.data ? (
                  <>
                    <p className="text-sm font-light leading-relaxed text-foreground/90">
                      {suggestions.data.headline}
                    </p>
                    <div className="space-y-3">
                      {suggestions.data.actions.map((action, i) => (
                        <motion.div
                          key={i}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.08 }}
                          className="rounded-2xl bg-foreground/[0.04] border border-white/10 p-4"
                        >
                          <div className="flex items-start gap-3">
                            <span className="w-7 h-7 rounded-full bg-primary/15 text-primary flex items-center justify-center shrink-0 mt-0.5">
                              <Zap className="w-3.5 h-3.5" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-semibold text-sm">
                                  {action.title}
                                </span>
                                <span
                                  className={cn(
                                    "text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ring-1",
                                    PRIORITY_STYLE[action.priority] ??
                                      PRIORITY_STYLE.low,
                                  )}
                                >
                                  {action.priority}
                                </span>
                              </div>
                              <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                                {action.detail}
                              </p>
                              {action.leadName && (
                                <div className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
                                  <ChevronRight className="w-3 h-3" />
                                  {action.leadName}
                                </div>
                              )}
                            </div>
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
        </>
      )}
    </Page>
  );
}
