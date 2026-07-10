import { useGetDashboardSummary, useListActivity, useGetSalesPerformance } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Users, Car, DollarSign, CheckCircle } from "lucide-react";
import { format } from "date-fns";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export default function Dashboard() {
  const { data: summary, isLoading: isSummaryLoading } = useGetDashboardSummary();
  const { data: activities, isLoading: isActivityLoading } = useListActivity({ limit: 10 });
  const { data: salesPerformance } = useGetSalesPerformance();

  if (isSummaryLoading || isActivityLoading) {
    return <div className="animate-pulse space-y-4">
      <div className="h-8 w-64 bg-muted rounded"></div>
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => <div key={i} className="h-32 bg-muted rounded"></div>)}
      </div>
    </div>;
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Command Center</h1>
        <div className="flex items-center gap-2 text-sm text-muted-foreground bg-white px-3 py-1.5 rounded-full border shadow-sm">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
          </span>
          Agents Active
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="hover-elevate">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Monthly Revenue</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">${summary.monthlyRevenue.toLocaleString()}</div>
            </CardContent>
          </Card>
          <Card className="hover-elevate">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Leads</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary.totalLeads}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {summary.conversionRate.toFixed(1)}% conversion
              </p>
            </CardContent>
          </Card>
          <Card className="hover-elevate">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Inventory Count</CardTitle>
              <Car className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary.inventoryCount}</div>
            </CardContent>
          </Card>
          <Card className="hover-elevate">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Agent Tasks Today</CardTitle>
              <CheckCircle className="h-4 w-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-primary">{summary.agentTasksToday}</div>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="col-span-2">
          {/* Main content area */}
          <Card className="h-[400px]">
             <CardHeader>
               <CardTitle>Sales Performance</CardTitle>
             </CardHeader>
             <CardContent className="h-[320px]">
               <ResponsiveContainer width="100%" height="100%">
                 <AreaChart data={salesPerformance ?? []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                   <defs>
                     <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
                       <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                       <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                     </linearGradient>
                   </defs>
                   <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                   <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={12} stroke="hsl(var(--muted-foreground))" />
                   <YAxis
                     tickLine={false}
                     axisLine={false}
                     fontSize={12}
                     stroke="hsl(var(--muted-foreground))"
                     tickFormatter={(v) => `$${(Number(v) / 1000).toFixed(0)}k`}
                   />
                   <Tooltip
                     formatter={(value: number, name) =>
                       name === "revenue" ? [`$${Number(value).toLocaleString()}`, "Revenue"] : [value, "Units"]
                     }
                     contentStyle={{ borderRadius: 12, border: "1px solid hsl(var(--border))" }}
                   />
                   <Area
                     type="monotone"
                     dataKey="revenue"
                     stroke="hsl(var(--primary))"
                     strokeWidth={2.5}
                     fill="url(#revenueFill)"
                   />
                 </AreaChart>
               </ResponsiveContainer>
             </CardContent>
          </Card>
        </div>
        <div>
          <Card className="h-[400px] flex flex-col">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-5 w-5" />
                Live Agent Feed
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 overflow-auto pr-2">
              <div className="space-y-4">
                {activities?.map((activity) => (
                  <div key={activity.id} className="flex gap-3 text-sm">
                    <div className="mt-0.5 flex-none">
                      <div className={`h-2 w-2 rounded-full ${activity.isAi ? 'bg-primary' : 'bg-gray-300'}`} />
                    </div>
                    <div>
                      <p className="text-gray-900">
                        <span className="font-medium">{activity.actor}</span>{" "}
                        {activity.action}
                        {activity.entity && <span className="font-medium text-primary"> {activity.entity}</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(activity.createdAt), "HH:mm:ss a")}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}