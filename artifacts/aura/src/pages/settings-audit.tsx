import { PageHero } from "@/components/layout/page-hero";
import { SettingsTabs } from "@/components/settings-nav";
import { useState } from "react";
import { useListAuditLogs } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, ScrollText } from "lucide-react";

const ACTIONS = [
  "create",
  "update",
  "delete",
  "approve",
  "reject",
  "login",
  "logout",
] as const;
const MODULES = [
  "dashboard",
  "inventory",
  "leads",
  "deals",
  "appraisals",
  "finance",
  "service",
  "customers",
  "approvals",
  "gra",
  "settings",
] as const;

const ACTION_COLORS: Record<string, string> = {
  create: "border-emerald-500/40 text-emerald-400",
  update: "border-violet-500/40 text-violet-400",
  delete: "border-red-500/40 text-red-400",
  approve: "border-emerald-500/40 text-emerald-400",
  reject: "border-red-500/40 text-red-400",
  login: "border-white/20 text-foreground",
  logout: "border-white/20 text-muted-foreground",
};

const ALL = "__all__";

export default function SettingsAudit() {
  const [action, setAction] = useState<string>(ALL);
  const [module, setModule] = useState<string>(ALL);
  const [search, setSearch] = useState("");

  const { data: logs, isLoading } = useListAuditLogs({
    ...(action !== ALL ? { action: action as (typeof ACTIONS)[number] } : {}),
    ...(module !== ALL ? { module: module as (typeof MODULES)[number] } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
  });

  return (
    <>
    <PageHero
      eyebrow="Settings"
      icon={ScrollText}
      title="Audit"
      accent="Logs"
      subtitle="Every sign-in and change across the dealership, newest first."
    />
    <SettingsTabs />
    <div className="w-full px-5 md:px-8 pb-8 space-y-6">

      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Search actor or summary…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64 bg-white/[0.03] border-white/10"
        />
        <Select value={action} onValueChange={setAction}>
          <SelectTrigger className="w-40 bg-white/[0.03] border-white/10">
            <SelectValue placeholder="All actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All actions</SelectItem>
            {ACTIONS.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={module} onValueChange={setModule}>
          <SelectTrigger className="w-44 bg-white/[0.03] border-white/10">
            <SelectValue placeholder="All modules" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All modules</SelectItem>
            {MODULES.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading audit trail…
        </div>
      ) : (logs ?? []).length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-10 text-center text-muted-foreground">
          No audit entries match these filters.
        </div>
      ) : (
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-5 py-3">When</th>
                <th className="px-5 py-3">Actor</th>
                <th className="px-5 py-3">Action</th>
                <th className="px-5 py-3">Module</th>
                <th className="px-5 py-3">Summary</th>
              </tr>
            </thead>
            <tbody>
              {(logs ?? []).map((log) => (
                <tr key={log.id} className="border-b border-white/[0.04] hover:bg-foreground/[0.02]">
                  <td className="px-5 py-3 whitespace-nowrap text-muted-foreground">
                    {log.createdAt ? new Date(log.createdAt).toLocaleString() : "—"}
                  </td>
                  <td className="px-5 py-3">
                    <div className="font-medium text-foreground">{log.actorName ?? "System"}</div>
                    <div className="text-xs text-muted-foreground">{log.actorEmail ?? ""}</div>
                  </td>
                  <td className="px-5 py-3">
                    <Badge variant="outline" className={ACTION_COLORS[log.action] ?? "border-white/20"}>
                      {log.action}
                    </Badge>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">{log.module}</td>
                  <td className="px-5 py-3 text-foreground/90">{log.summary ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
    </>
  );
}
