import { useListDealers, useListPlatformUsers, useListPlatformAudit } from "@workspace/api-client-react";
import { Network, Users, Activity, Building2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Dashboard() {
  const { data: dealers } = useListDealers();
  const { data: users } = useListPlatformUsers();
  const { data: audit } = useListPlatformAudit({ limit: 5 });

  const activeDealers = (dealers ?? []).filter(d => d.status === "active").length;
  const suspendedDealers = (dealers ?? []).length - activeDealers;

  return (
    <div className="space-y-8 font-sans">
      <div className="border-b border-border pb-6">
        <h1 className="text-3xl font-serif text-foreground">Command Overview</h1>
        <p className="text-sm text-muted-foreground mt-2 uppercase tracking-widest">Network status and high-level platform metrics</p>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Card className="bg-white border-border rounded-none shadow-none">
          <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/40">
            <CardTitle className="text-[10px] uppercase tracking-widest text-muted-foreground">Network Size</CardTitle>
            <Network className="w-4 h-4 text-black" />
          </CardHeader>
          <CardContent className="pt-4">
            <div className="text-4xl font-serif text-black">{(dealers ?? []).length}</div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground mt-3">
              <span className="text-black">{activeDealers} active</span> <span className="mx-2">•</span> <span className="text-muted-foreground">{suspendedDealers} suspended</span>
            </p>
          </CardContent>
        </Card>

        <Card className="bg-white border-border rounded-none shadow-none">
          <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/40">
            <CardTitle className="text-[10px] uppercase tracking-widest text-muted-foreground">Platform Users</CardTitle>
            <Users className="w-4 h-4 text-black" />
          </CardHeader>
          <CardContent className="pt-4">
            <div className="text-4xl font-serif text-black">{(users ?? []).length}</div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground mt-3">Across all workspaces</p>
          </CardContent>
        </Card>

        <Card className="bg-white border-border rounded-none shadow-none">
          <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/40">
            <CardTitle className="text-[10px] uppercase tracking-widest text-muted-foreground">Recent Events</CardTitle>
            <Activity className="w-4 h-4 text-black" />
          </CardHeader>
          <CardContent className="pt-4">
            <div className="text-4xl font-serif text-black">{(audit ?? []).length}</div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground mt-3">Logged actions recently</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="bg-white border-border rounded-none shadow-none">
          <CardHeader className="border-b border-border/40 pb-4">
            <CardTitle className="text-lg font-serif">Recent Dealerships</CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="space-y-6">
              {(dealers ?? []).slice(0, 5).map(dealer => (
                <div key={dealer.id} className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 bg-muted/30 flex items-center justify-center text-black border border-border">
                      <Building2 className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="font-serif text-base text-black">{dealer.name}</div>
                      <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">{dealer.city || "No city"} • {dealer.country || "No country"}</div>
                    </div>
                  </div>
                  <div className="text-[10px] uppercase tracking-widest">
                    {dealer.status === "active" ? (
                      <span className="text-black font-medium border border-black/20 px-2 py-1 bg-black/5">Active</span>
                    ) : (
                      <span className="text-muted-foreground border border-border px-2 py-1">Suspended</span>
                    )}
                  </div>
                </div>
              ))}
              {(dealers ?? []).length === 0 && (
                <div className="text-sm text-muted-foreground py-4 text-center font-serif italic">No dealerships found.</div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-white border-border rounded-none shadow-none">
          <CardHeader className="border-b border-border/40 pb-4">
            <CardTitle className="text-lg font-serif">Recent Platform Activity</CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="space-y-5">
              {(audit ?? []).map(entry => (
                <div key={entry.id} className="flex gap-4">
                  <div className="w-1.5 h-1.5 mt-2 bg-black shrink-0" />
                  <div>
                    <div className="text-sm text-black leading-snug">{entry.summary}</div>
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-2">
                      {entry.actorName || entry.actorEmail || "System"} <span className="mx-1">•</span> {new Date(entry.createdAt).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
              {(audit ?? []).length === 0 && (
                <div className="text-sm text-muted-foreground py-4 text-center font-serif italic">No recent activity.</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
