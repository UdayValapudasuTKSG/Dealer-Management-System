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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Command Overview</h1>
        <p className="text-muted-foreground mt-1">Network status and high-level platform metrics.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="bg-card/50 border-white/5">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Network Size</CardTitle>
            <Network className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-white">{(dealers ?? []).length}</div>
            <p className="text-xs text-muted-foreground mt-1">
              <span className="text-emerald-400">{activeDealers} active</span>, <span className="text-amber-400">{suspendedDealers} suspended</span>
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card/50 border-white/5">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Platform Users</CardTitle>
            <Users className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-white">{(users ?? []).length}</div>
            <p className="text-xs text-muted-foreground mt-1">Across all workspaces</p>
          </CardContent>
        </Card>

        <Card className="bg-card/50 border-white/5">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Recent Events</CardTitle>
            <Activity className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-white">{(audit ?? []).length}</div>
            <p className="text-xs text-muted-foreground mt-1">Logged actions recently</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="bg-card/50 border-white/5">
          <CardHeader>
            <CardTitle className="text-lg">Recent Dealerships</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {(dealers ?? []).slice(0, 5).map(dealer => (
                <div key={dealer.id} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                      <Building2 className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="font-medium text-sm text-white">{dealer.name}</div>
                      <div className="text-xs text-muted-foreground">{dealer.city || "No city"} • {dealer.country || "No country"}</div>
                    </div>
                  </div>
                  <div className="text-xs">
                    {dealer.status === "active" ? (
                      <span className="text-emerald-400 font-medium">Active</span>
                    ) : (
                      <span className="text-amber-400 font-medium">Suspended</span>
                    )}
                  </div>
                </div>
              ))}
              {(dealers ?? []).length === 0 && (
                <div className="text-sm text-muted-foreground py-4 text-center">No dealerships found.</div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/50 border-white/5">
          <CardHeader>
            <CardTitle className="text-lg">Recent Platform Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {(audit ?? []).map(entry => (
                <div key={entry.id} className="flex gap-3">
                  <div className="w-2 h-2 mt-1.5 rounded-full bg-primary/50 shrink-0" />
                  <div>
                    <div className="text-sm text-white">{entry.summary}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {entry.actorName || entry.actorEmail || "System"} • {new Date(entry.createdAt).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
              {(audit ?? []).length === 0 && (
                <div className="text-sm text-muted-foreground py-4 text-center">No recent activity.</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
