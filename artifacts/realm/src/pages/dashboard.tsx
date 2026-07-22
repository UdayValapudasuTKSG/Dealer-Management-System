import { useListDealers, useListPlatformUsers, useListPlatformAudit } from "@workspace/api-client-react";
import { Network, Users, Activity, Building2 } from "lucide-react";

export default function Dashboard() {
  const { data: dealers } = useListDealers();
  const { data: users } = useListPlatformUsers();
  const { data: audit } = useListPlatformAudit({ limit: 5 });

  const activeDealers = (dealers ?? []).filter(d => d.status === "active").length;
  const suspendedDealers = (dealers ?? []).length - activeDealers;

  return (
    <div className="space-y-8 font-sans">
      <div className="border-b border-border/50 pb-6">
        <h1 className="text-3xl font-serif tracking-wide">Command Overview</h1>
        <p className="text-xs text-muted-foreground mt-2 uppercase tracking-[0.15em]">Network status and high-level platform metrics</p>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <div className="glass-panel p-6 flex flex-col justify-between">
          <div className="flex flex-row items-center justify-between pb-4 border-b border-white/5 mb-4">
            <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Network Size</h3>
            <Network className="w-4 h-4 opacity-50" />
          </div>
          <div>
            <div className="text-4xl font-serif tracking-tight">{(dealers ?? []).length}</div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground mt-3 flex items-center gap-2">
              <span className="text-foreground font-medium">{activeDealers} active</span> 
              <span className="w-1 h-1 rounded-full bg-white/20"></span>
              <span>{suspendedDealers} suspended</span>
            </p>
          </div>
        </div>

        <div className="glass-panel p-6 flex flex-col justify-between">
          <div className="flex flex-row items-center justify-between pb-4 border-b border-white/5 mb-4">
            <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Platform Users</h3>
            <Users className="w-4 h-4 opacity-50" />
          </div>
          <div>
            <div className="text-4xl font-serif tracking-tight">{(users ?? []).length}</div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground mt-3">Across all workspaces</p>
          </div>
        </div>

        <div className="glass-panel p-6 flex flex-col justify-between">
          <div className="flex flex-row items-center justify-between pb-4 border-b border-white/5 mb-4">
            <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Recent Events</h3>
            <Activity className="w-4 h-4 opacity-50" />
          </div>
          <div>
            <div className="text-4xl font-serif tracking-tight">{(audit ?? []).length}</div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground mt-3">Logged actions recently</p>
          </div>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="glass-panel">
          <div className="px-6 py-5 border-b border-white/5">
            <h3 className="text-lg font-serif">Recent Dealerships</h3>
          </div>
          <div className="p-6">
            <div className="space-y-6">
              {(dealers ?? []).slice(0, 5).map(dealer => (
                <div key={dealer.id} className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-xl bg-white/[0.03] border border-white/5 flex items-center justify-center shrink-0">
                      <Building2 className="w-4 h-4 opacity-70" />
                    </div>
                    <div>
                      <div className="font-serif text-base tracking-wide">{dealer.name}</div>
                      <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">{dealer.city || "No city"} • {dealer.country || "No country"}</div>
                    </div>
                  </div>
                  <div className="text-[9px] uppercase tracking-[0.2em]">
                    {dealer.status === "active" ? (
                      <span className="font-medium bg-white/[0.08] text-foreground px-2 py-1 rounded-sm border border-white/10">Active</span>
                    ) : (
                      <span className="text-muted-foreground border border-white/10 px-2 py-1 rounded-sm bg-black/20">Suspended</span>
                    )}
                  </div>
                </div>
              ))}
              {(dealers ?? []).length === 0 && (
                <div className="text-sm text-muted-foreground py-4 text-center font-serif italic">No dealerships found.</div>
              )}
            </div>
          </div>
        </div>

        <div className="glass-panel">
          <div className="px-6 py-5 border-b border-white/5">
            <h3 className="text-lg font-serif">Recent Platform Activity</h3>
          </div>
          <div className="p-6">
            <div className="space-y-6">
              {(audit ?? []).map(entry => (
                <div key={entry.id} className="flex gap-4">
                  <div className="w-1.5 h-1.5 mt-2 rounded-full bg-foreground/40 shrink-0" />
                  <div>
                    <div className="text-sm text-foreground/90 leading-snug font-medium">{entry.summary}</div>
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-2">
                      {entry.actorName || entry.actorEmail || "System"} <span className="mx-1 opacity-50">•</span> {new Date(entry.createdAt).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
              {(audit ?? []).length === 0 && (
                <div className="text-sm text-muted-foreground py-4 text-center font-serif italic">No recent activity.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

