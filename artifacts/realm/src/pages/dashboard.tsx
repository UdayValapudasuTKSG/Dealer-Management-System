import { useListDealers, useListPlatformUsers, useListPlatformAudit } from "@workspace/api-client-react";
import { Network, Users, Activity, Building2 } from "lucide-react";

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500 ${className || ""}`}>
      {children}
    </div>
  );
}

function PageHeader({ eyebrow, title, subtitle, right }: { eyebrow?: string; title: string; subtitle?: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 flex-wrap">
      <div>
        {eyebrow && <SectionLabel>{eyebrow}</SectionLabel>}
        <h1 className="mt-2 font-serif text-4xl tracking-tight text-zinc-900">{title}</h1>
        {subtitle && (
          <p className="mt-2 text-[13.5px] text-zinc-600 max-w-2xl leading-relaxed">
            {subtitle}
          </p>
        )}
      </div>
      {right}
    </div>
  );
}

export default function Dashboard() {
  const { data: dealers } = useListDealers();
  const { data: users } = useListPlatformUsers();
  const { data: audit } = useListPlatformAudit({ limit: 5 });

  const activeDealers = (dealers ?? []).filter(d => d.status === "active").length;
  const suspendedDealers = (dealers ?? []).length - activeDealers;

  return (
    <div className="w-full px-4 md:px-6 py-8 space-y-6">
      <PageHeader 
        eyebrow="OVERVIEW" 
        title="Command Overview" 
        subtitle="Network status and high-level platform metrics." 
      />

      <div className="grid gap-5 md:grid-cols-3">
        <div className="glass-strong rounded-2xl p-6 flex flex-col justify-between hover-elevate">
          <div className="flex flex-row items-center justify-between pb-4 border-b border-black/5 mb-4">
            <SectionLabel>Network Size</SectionLabel>
            <Network className="w-3.5 h-3.5 text-zinc-400" />
          </div>
          <div>
            <div className="font-serif text-5xl font-medium tracking-tight tabular-nums text-zinc-900">{(dealers ?? []).length}</div>
            <p className="text-[11px] uppercase tracking-wider text-zinc-500 mt-3 flex items-center gap-2">
              <span className="text-zinc-900 font-medium">{activeDealers} active</span> 
              <span className="w-1 h-1 rounded-full bg-zinc-300"></span>
              <span>{suspendedDealers} suspended</span>
            </p>
          </div>
        </div>

        <div className="glass-strong rounded-2xl p-6 flex flex-col justify-between hover-elevate">
          <div className="flex flex-row items-center justify-between pb-4 border-b border-black/5 mb-4">
            <SectionLabel>Platform Users</SectionLabel>
            <Users className="w-3.5 h-3.5 text-zinc-400" />
          </div>
          <div>
            <div className="font-serif text-5xl font-medium tracking-tight tabular-nums text-zinc-900">{(users ?? []).length}</div>
            <p className="text-[11px] uppercase tracking-wider text-zinc-500 mt-3">Across all workspaces</p>
          </div>
        </div>

        <div className="glass-strong rounded-2xl p-6 flex flex-col justify-between hover-elevate">
          <div className="flex flex-row items-center justify-between pb-4 border-b border-black/5 mb-4">
            <SectionLabel>Recent Events</SectionLabel>
            <Activity className="w-3.5 h-3.5 text-zinc-400" />
          </div>
          <div>
            <div className="font-serif text-5xl font-medium tracking-tight tabular-nums text-zinc-900">{(audit ?? []).length}</div>
            <p className="text-[11px] uppercase tracking-wider text-zinc-500 mt-3">Logged actions recently</p>
          </div>
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <div className="glass rounded-2xl p-5 hover-elevate">
          <div className="pb-4 border-b border-black/5">
            <h3 className="font-serif text-[14.5px] tracking-tight">Recent Dealerships</h3>
          </div>
          <div className="pt-4">
            <div className="space-y-4">
              {(dealers ?? []).slice(0, 5).map(dealer => (
                <div key={dealer.id} className="flex items-center justify-between group">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-zinc-100 border border-black/5 flex items-center justify-center shrink-0">
                      <Building2 className="w-3.5 h-3.5 text-zinc-500" />
                    </div>
                    <div>
                      <div className="text-[13px] font-medium text-zinc-900">{dealer.name}</div>
                      <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500 mt-0.5">{dealer.city || "No city"} • {dealer.country || "No country"}</div>
                    </div>
                  </div>
                  <div>
                    {dealer.status === "active" ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[10.5px] font-medium text-emerald-700">
                        <span className="relative flex h-1.5 w-1.5">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        </span>
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-zinc-50 px-2.5 py-0.5 text-[10.5px] font-medium text-zinc-700">
                        <span className="h-1.5 w-1.5 rounded-full bg-zinc-400" />
                        Suspended
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {(dealers ?? []).length === 0 && (
                <div className="text-[13px] text-zinc-500 py-4 text-center">No dealerships found.</div>
              )}
            </div>
          </div>
        </div>

        <div className="glass rounded-2xl p-5 hover-elevate">
          <div className="pb-4 border-b border-black/5">
            <h3 className="font-serif text-[14.5px] tracking-tight">Recent Platform Activity</h3>
          </div>
          <div className="pt-4">
            <div className="space-y-4">
              {(audit ?? []).map(entry => (
                <div key={entry.id} className="flex gap-3">
                  <div className="w-1.5 h-1.5 mt-1.5 rounded-full bg-zinc-300 shrink-0" />
                  <div>
                    <div className="text-[13px] text-zinc-900 leading-snug">{entry.summary}</div>
                    <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500 mt-1">
                      {entry.actorName || entry.actorEmail || "System"} <span className="mx-1 opacity-50">•</span> <span className="font-mono text-[10.5px] lowercase tabular-nums">{new Date(entry.createdAt).toLocaleTimeString()}</span>
                    </div>
                  </div>
                </div>
              ))}
              {(audit ?? []).length === 0 && (
                <div className="text-[13px] text-zinc-500 py-4 text-center">No recent activity.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
