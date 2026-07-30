import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  CheckCircle2,
  XCircle,
  MinusCircle,
  AlertTriangle,
  Search,
  Activity,
  Pause,
  Play,
  Clock,
} from "lucide-react";
import {
  useListDealers,
  useGetDealerAgentsOverview,
  getGetDealerAgentsOverviewQueryKey,
  useListDealerAgentRuns,
  useUpdateDealerAgent,
  type DealerAgentOverview,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const HEALTH_META: Record<
  string,
  { label: string; className: string }
> = {
  meeting: { label: "Meeting criteria", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  at_risk: { label: "At risk", className: "bg-amber-50 text-amber-700 border-amber-200" },
  no_data: { label: "No data yet", className: "bg-zinc-100 text-zinc-500 border-zinc-200" },
};

const STATUS_META: Record<string, string> = {
  active: "bg-emerald-500",
  idle: "bg-zinc-300",
  paused: "bg-amber-500",
};

function CriterionRow({
  c,
}: {
  c: DealerAgentOverview["criteria"][number];
}) {
  const icon =
    c.met === true ? (
      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
    ) : c.met === false ? (
      <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
    ) : (
      <MinusCircle className="h-3.5 w-3.5 text-zinc-300 shrink-0" />
    );
  return (
    <div className="flex items-center gap-2 py-1 text-[12px]">
      {icon}
      <span className={cn("flex-1", c.met === null && "text-zinc-400")}>{c.label}</span>
      <span className="font-mono text-[11px] text-zinc-500">
        {c.actual ?? "—"}
      </span>
      <span className="font-mono text-[11px] text-zinc-400 w-16 text-right">
        {c.target}
      </span>
    </div>
  );
}

function AgentCard({
  dealerId,
  item,
}: {
  dealerId: number;
  item: DealerAgentOverview;
}) {
  const { agent, metrics, criteria, health } = item;
  const qc = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateDealerAgent({
    mutation: {
      onSuccess: () =>
        qc.invalidateQueries({ queryKey: getGetDealerAgentsOverviewQueryKey(dealerId) }),
      onError: (e: unknown) =>
        toast({
          title: "Could not update agent",
          description: e instanceof Error ? e.message : "Request failed",
          variant: "destructive",
        }),
    },
  });
  const healthMeta = HEALTH_META[health] ?? HEALTH_META.no_data;
  const paused = agent.status === "paused";

  return (
    <div className="glass rounded-lg border border-zinc-200 p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <span className="mt-0.5 h-8 w-8 rounded bg-zinc-900 text-zinc-100 flex items-center justify-center shrink-0">
            <Bot className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-medium text-zinc-900 truncate">{agent.name}</span>
              <span
                className={cn("h-1.5 w-1.5 rounded-full shrink-0", STATUS_META[agent.status] ?? "bg-zinc-300")}
                title={agent.status}
              />
            </div>
            <div className="text-[11px] text-zinc-500">{agent.domain}</div>
          </div>
        </div>
        <Badge variant="outline" className={cn("shrink-0 text-[10px]", healthMeta.className)}>
          {health === "at_risk" && <AlertTriangle className="h-3 w-3 mr-1" />}
          {healthMeta.label}
        </Badge>
      </div>

      <p className="text-[12px] leading-relaxed text-zinc-500 line-clamp-2">{agent.description}</p>

      <div className="grid grid-cols-4 gap-2 text-center">
        {[
          { label: "Runs", value: metrics?.runs ?? 0 },
          { label: "Errors", value: metrics?.errors ?? 0 },
          { label: "Blocked", value: metrics?.blocked ?? 0 },
          {
            label: "Avg latency",
            value: metrics?.avgLatencyMs != null ? `${(metrics.avgLatencyMs / 1000).toFixed(1)}s` : "—",
          },
        ].map((s) => (
          <div key={s.label} className="rounded border border-zinc-100 bg-white/50 py-1.5">
            <div className="font-mono text-[13px] text-zinc-900">{s.value}</div>
            <div className="text-[9px] uppercase tracking-wider text-zinc-400">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="border-t border-zinc-100 pt-2">
        <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-400 mb-1">
          Success criteria
        </div>
        {criteria.map((c) => (
          <CriterionRow key={c.key} c={c} />
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-zinc-100 pt-3">
        <span className="text-[11px] text-zinc-400 flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {metrics?.lastRunAt
            ? `Last run ${new Date(metrics.lastRunAt).toLocaleString()}`
            : "Never run"}
        </span>
        <Button
          size="sm"
          variant={paused ? "default" : "outline"}
          className="h-7 text-[11px]"
          disabled={update.isPending}
          onClick={() =>
            update.mutate({
              id: dealerId,
              agentId: agent.id,
              data: { status: paused ? "active" : "paused" },
            })
          }
        >
          {paused ? (
            <>
              <Play className="h-3 w-3 mr-1" /> Resume
            </>
          ) : (
            <>
              <Pause className="h-3 w-3 mr-1" /> Pause
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

const RUN_STATUS_CLASS: Record<string, string> = {
  completed: "text-emerald-600",
  accepted: "text-emerald-600",
  needs_review: "text-amber-600",
  overridden: "text-zinc-500",
  error: "text-red-600",
  blocked: "text-red-500",
};

function RunsFeed({ dealerId }: { dealerId: number }) {
  const { data: runs, isLoading } = useListDealerAgentRuns(dealerId);
  if (isLoading) return <div className="text-[12px] text-zinc-400 p-4">Loading runs…</div>;
  if (!runs || runs.length === 0)
    return <div className="text-[12px] text-zinc-400 p-4">No agent runs recorded for this dealership yet.</div>;
  return (
    <div className="divide-y divide-zinc-100">
      {runs.slice(0, 40).map((run) => (
        <div key={run.id} className="flex items-center gap-3 px-4 py-2 text-[12px]">
          <span className="font-mono text-zinc-400 w-10 shrink-0">#{run.id}</span>
          <span className="font-medium text-zinc-700 w-40 truncate shrink-0">{run.agentKey}</span>
          <span className={cn("w-24 shrink-0 font-medium", RUN_STATUS_CLASS[run.status] ?? "text-zinc-500")}>
            {run.status.replace("_", " ")}
          </span>
          <span className="flex-1 truncate text-zinc-500">
            {run.outputSummary ?? run.inputSummary ?? run.changeSummary ?? "—"}
          </span>
          <span className="text-zinc-400 shrink-0 font-mono text-[11px]">
            {new Date(run.createdAt).toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function AgentsPage() {
  const { data: dealers, isLoading } = useListDealers();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  const visibleDealers = useMemo(() => {
    const list = (dealers ?? []).filter((d) => d.status !== "closed");
    const q = search.trim().toLowerCase();
    return q ? list.filter((d) => d.name.toLowerCase().includes(q)) : list;
  }, [dealers, search]);

  const activeId = selectedId ?? visibleDealers[0]?.id ?? null;
  const activeDealer = visibleDealers.find((d) => d.id === activeId) ?? (dealers ?? []).find((d) => d.id === activeId);

  const { data: overview, isLoading: overviewLoading } = useGetDealerAgentsOverview(
    activeId ?? 0,
    { query: { enabled: activeId != null, queryKey: getGetDealerAgentsOverviewQueryKey(activeId ?? 0) } },
  );

  const summary = useMemo(() => {
    if (!overview) return null;
    return {
      meeting: overview.filter((o) => o.health === "meeting").length,
      atRisk: overview.filter((o) => o.health === "at_risk").length,
      noData: overview.filter((o) => o.health === "no_data").length,
      paused: overview.filter((o) => o.agent.status === "paused").length,
    };
  }, [overview]);

  return (
    <div className="p-6 md:p-8 max-w-[1400px] mx-auto">
      <div className="mb-6">
        <h1 className="font-serif text-2xl text-zinc-900">AI Agents</h1>
        <p className="text-[13px] text-zinc-500 mt-1">
          Per-dealership agent workforce, governance metrics and success criteria.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">
        {/* Dealer picker */}
        <div className="glass rounded-lg border border-zinc-200 overflow-hidden self-start">
          <div className="p-3 border-b border-zinc-100">
            <div className="relative">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search dealerships"
                className="h-8 pl-8 text-[12px]"
              />
            </div>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {isLoading && <div className="p-4 text-[12px] text-zinc-400">Loading…</div>}
            {visibleDealers.map((d) => (
              <button
                key={d.id}
                onClick={() => setSelectedId(d.id)}
                className={cn(
                  "w-full text-left px-4 py-2.5 text-[13px] border-b border-zinc-50 transition-colors",
                  d.id === activeId
                    ? "bg-zinc-900 text-white"
                    : "text-zinc-700 hover:bg-zinc-50",
                )}
              >
                <div className="font-medium truncate">{d.name}</div>
                <div className={cn("text-[10px] uppercase tracking-wider", d.id === activeId ? "text-zinc-400" : "text-zinc-400")}>
                  {d.status}
                </div>
              </button>
            ))}
            {!isLoading && visibleDealers.length === 0 && (
              <div className="p-4 text-[12px] text-zinc-400">No dealerships found.</div>
            )}
          </div>
        </div>

        {/* Agents */}
        <div className="min-w-0">
          {activeDealer && summary && (
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <span className="font-serif text-lg text-zinc-900 mr-2">{activeDealer.name}</span>
              <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 text-[10px]">
                {summary.meeting} meeting criteria
              </Badge>
              <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-[10px]">
                {summary.atRisk} at risk
              </Badge>
              <Badge variant="outline" className="bg-zinc-100 text-zinc-500 border-zinc-200 text-[10px]">
                {summary.noData} no data
              </Badge>
              {summary.paused > 0 && (
                <Badge variant="outline" className="bg-red-50 text-red-600 border-red-200 text-[10px]">
                  {summary.paused} paused
                </Badge>
              )}
            </div>
          )}

          {overviewLoading && <div className="text-[13px] text-zinc-400">Loading agents…</div>}
          {!overviewLoading && activeId != null && (!overview || overview.length === 0) && (
            <div className="glass rounded-lg border border-zinc-200 p-8 text-center text-[13px] text-zinc-500">
              This dealership has no provisioned agents.
            </div>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {activeId != null &&
              (overview ?? []).map((item) => (
                <AgentCard key={item.agent.id} dealerId={activeId} item={item} />
              ))}
          </div>

          {activeId != null && (
            <div className="glass rounded-lg border border-zinc-200 mt-6 overflow-hidden">
              <div className="px-4 py-3 border-b border-zinc-100 flex items-center gap-2">
                <Activity className="h-3.5 w-3.5 text-zinc-500" />
                <span className="text-[12px] font-medium uppercase tracking-[0.14em] text-zinc-600">
                  Recent runs
                </span>
              </div>
              <RunsFeed dealerId={activeId} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
