import { useMemo } from "react";
import {
  useListAgents,
  useUpdateAgent,
  useListActivity,
  getListAgentsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Bot,
  Mail,
  MessageCircle,
  Gauge,
  Sparkles,
  FileText,
  Play,
  Pause,
  Activity as ActivityIcon,
  type LucideIcon,
} from "lucide-react";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const DOMAIN_ICON: Record<string, LucideIcon> = {
  email: Mail,
  whatsapp: MessageCircle,
  scoring: Gauge,
  concierge: Sparkles,
  documents: FileText,
};

const STATUS_STYLE: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-600 ring-emerald-500/30",
  idle: "bg-amber-500/15 text-amber-600 ring-amber-500/30",
  paused: "bg-foreground/[0.06] text-muted-foreground ring-border",
};

function timeAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function Agents() {
  const { data: agents, isLoading } = useListAgents();
  const { data: activity } = useListActivity({ limit: 40 });
  const updateAgent = useUpdateAgent();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const aiActivity = useMemo(
    () => (activity ?? []).filter((a) => a.isAi),
    [activity],
  );

  const activeCount = (agents ?? []).filter((a) => a.status === "active").length;
  const tasksToday = (agents ?? []).reduce((s, a) => s + a.tasksToday, 0);

  const toggle = async (id: number, status: string) => {
    const next = status === "paused" ? "active" : "paused";
    await updateAgent.mutateAsync({ id, data: { status: next } });
    queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
    toast({
      title: next === "paused" ? "Agent paused" : "Agent resumed",
    });
  };

  return (
    <>
      <PageHero
        eyebrow="Autonomous Workforce"
        icon={Bot}
        title="AI"
        accent="Agents"
        subtitle={
          isLoading
            ? "Loading the agent roster…"
            : `${activeCount} active · ${tasksToday} tasks handled today`
        }
      />
      <Page className="space-y-6">
        {/* Agent roster */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {isLoading
            ? [1, 2, 3, 4, 5, 6].map((i) => (
                <div
                  key={i}
                  className="h-40 rounded-2xl bg-foreground/[0.04] animate-pulse"
                />
              ))
            : (agents ?? []).map((agent, i) => {
                const Icon = DOMAIN_ICON[agent.domain] ?? Bot;
                const paused = agent.status === "paused";
                return (
                  <motion.div
                    key={agent.id}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="rounded-2xl bg-card border border-border/60 shadow-sm p-5 flex flex-col gap-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/15 text-primary">
                          <Icon className="h-5 w-5" />
                        </span>
                        <div className="min-w-0">
                          <div className="font-semibold text-sm truncate">
                            {agent.name}
                          </div>
                          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                            {agent.domain}
                          </div>
                        </div>
                      </div>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1",
                          STATUS_STYLE[agent.status] ?? STATUS_STYLE.idle,
                        )}
                      >
                        {agent.status}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed flex-1">
                      {agent.description}
                    </p>
                    <div className="flex items-center justify-between pt-1 border-t border-border/50">
                      <div className="flex items-center gap-4 text-xs">
                        <span>
                          <span className="font-semibold tabular-nums">
                            {agent.tasksToday}
                          </span>{" "}
                          <span className="text-muted-foreground">today</span>
                        </span>
                        <span>
                          <span className="font-semibold tabular-nums">
                            {Math.round(agent.successRate)}%
                          </span>{" "}
                          <span className="text-muted-foreground">success</span>
                        </span>
                      </div>
                      <button
                        onClick={() => toggle(agent.id, agent.status)}
                        disabled={updateAgent.isPending}
                        className={cn(
                          "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors",
                          paused
                            ? "bg-primary text-white hover:bg-primary/90"
                            : "bg-foreground/[0.05] text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {paused ? (
                          <>
                            <Play className="h-3 w-3" /> Resume
                          </>
                        ) : (
                          <>
                            <Pause className="h-3 w-3" /> Pause
                          </>
                        )}
                      </button>
                    </div>
                  </motion.div>
                );
              })}
        </div>

        {/* Autonomous activity feed */}
        <div className="rounded-2xl bg-card border border-border/60 shadow-sm p-5">
          <div className="flex items-center gap-2 mb-4">
            <ActivityIcon className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
              Autonomous activity
            </h2>
          </div>
          {aiActivity.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">
              No autonomous actions recorded yet
            </div>
          ) : (
            <ul className="space-y-1">
              {aiActivity.map((a) => (
                <li
                  key={a.id}
                  className="flex items-start gap-3 rounded-xl px-3 py-2.5 hover:bg-foreground/[0.03] transition-colors"
                >
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Bot className="h-3 w-3" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm">
                      <span className="font-medium">{a.actor}</span>{" "}
                      <span className="text-muted-foreground">{a.action}</span>
                      {a.entity && (
                        <span className="text-foreground/80"> — {a.entity}</span>
                      )}
                    </div>
                    {a.detail && (
                      <div className="text-xs text-muted-foreground truncate">
                        {a.detail}
                      </div>
                    )}
                  </div>
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    {timeAgo(a.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Page>
    </>
  );
}
