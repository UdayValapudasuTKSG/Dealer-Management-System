import { Link } from "wouter";
import { 
  useGetDashboardSummary, 
  useGetSalesPerformance,
  useListTimeline,
  useListGates
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, TrendingUp, Users, Car, ArrowUpRight, ShieldAlert, ChevronRight } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Timeline } from "@/components/timeline";
import { motion } from "framer-motion";

export default function Dashboard() {
  const { data: summary, isLoading: isLoadingSummary } = useGetDashboardSummary();
  const { data: performance, isLoading: isLoadingPerf } = useGetSalesPerformance();
  const { data: timeline } = useListTimeline({ limit: 8 });
  const { data: gates } = useListGates({ status: "pending" });

  return (
    <div className="h-full overflow-y-auto">
      {/* Hero Section */}
      <div className="relative h-[45vh] min-h-[300px] w-full overflow-hidden bg-black flex items-center justify-center">
        <video 
          autoPlay 
          muted 
          loop 
          playsInline 
          className="absolute inset-0 w-full h-full object-cover opacity-60 mix-blend-screen"
        >
          <source src={`${import.meta.env.BASE_URL}videos/red_car_leaving_showroom.mp4`} type="video/mp4" />
        </video>
        <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent z-10" />
        <div className="relative z-20 text-center px-6">
          <motion.h1 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.2 }}
            className="text-5xl md:text-7xl font-bold tracking-tight text-white mb-4"
          >
            AURA <span className="font-light">Concierge</span>
          </motion.h1>
          <motion.p 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.6 }}
            className="text-lg md:text-xl text-white/80 font-light tracking-wide max-w-2xl mx-auto"
          >
            The luxury automotive experience, orchestrated end to end.
          </motion.p>
        </div>
      </div>

      <div className="p-6 md:p-10 -mt-20 relative z-30 max-w-7xl mx-auto space-y-8">
        
        {/* KPI Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <KPICard 
            title="Total Revenue" 
            value={summary ? `$${(summary.monthlyRevenue / 1000).toFixed(1)}k` : "$0"}
            trend="+12.5%"
            icon={TrendingUp}
            isLoading={isLoadingSummary}
            delay={0.1}
          />
          <KPICard 
            title="Active Deals" 
            value={summary?.activeDeals ?? 0}
            trend="+3"
            icon={Briefcase}
            isLoading={isLoadingSummary}
            delay={0.2}
          />
          <KPICard 
            title="Conversion" 
            value={summary ? `${summary.conversionRate}%` : "0%"}
            trend="+2.1%"
            icon={Users}
            isLoading={isLoadingSummary}
            delay={0.3}
          />
          <KPICard 
            title="Inventory" 
            value={summary?.inventoryCount ?? 0}
            trend="Stable"
            icon={Car}
            isLoading={isLoadingSummary}
            delay={0.4}
          />
        </div>

        {/* Decision gates banner */}
        {gates && gates.length > 0 && (
          <Link href="/approvals">
            <Card className="border-none shadow-lg overflow-hidden bg-primary/5 hover:bg-primary/10 transition-colors cursor-pointer">
              <CardContent className="p-5 flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-primary text-white flex items-center justify-center shrink-0">
                  <ShieldAlert className="w-5 h-5" />
                </div>
                <div className="flex-1">
                  <p className="font-semibold">
                    {gates.length} decision{gates.length > 1 ? "s" : ""} awaiting approval
                  </p>
                  <p className="text-sm text-muted-foreground">
                    The concierge handled everything else. Review what needs a human.
                  </p>
                </div>
                <ChevronRight className="w-5 h-5 text-muted-foreground" />
              </CardContent>
            </Card>
          </Link>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Performance Chart */}
          <Card className="lg:col-span-2 glass-panel border-none shadow-xl overflow-hidden">
            <div className="p-6 pb-2">
              <h3 className="text-lg font-semibold tracking-wide">Performance Trajectory</h3>
            </div>
            <CardContent className="p-0 h-[300px]">
              {isLoadingPerf ? (
                <div className="h-full flex items-center justify-center"><Loader2 className="animate-spin text-primary w-8 h-8" /></div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={performance} margin={{ top: 20, right: 20, left: 20, bottom: 20 }}>
                    <defs>
                      <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} dy={10} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} tickFormatter={(val) => `$${val/1000}k`} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(10px)', borderRadius: '12px', border: '1px solid rgba(0,0,0,0.1)' }}
                      itemStyle={{ color: 'hsl(var(--foreground))' }}
                    />
                    <Area type="monotone" dataKey="revenue" stroke="hsl(var(--primary))" strokeWidth={3} fillOpacity={1} fill="url(#colorRevenue)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Connected event stream */}
          <Card className="glass-panel border-none shadow-xl flex flex-col">
            <div className="p-6 border-b border-border/50">
              <h3 className="text-lg font-semibold tracking-wide">Live Orchestration</h3>
              <p className="text-xs text-muted-foreground mt-1">Every domain, one connected stream.</p>
            </div>
            <CardContent className="flex-1 p-6 overflow-y-auto">
              <Timeline events={timeline ?? []} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Briefcase(props: any) {
  return <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><rect width="20" height="14" x="2" y="7" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
}

function KPICard({ title, value, trend, icon: Icon, isLoading, delay }: any) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.5 }}
    >
      <Card className="glass-panel border-none shadow-lg overflow-hidden group hover:shadow-xl transition-all duration-300">
        <CardContent className="p-6 relative">
          <div className="absolute right-0 top-0 p-6 opacity-5 group-hover:opacity-10 transition-opacity transform group-hover:scale-110 duration-500">
            <Icon className="w-24 h-24" />
          </div>
          <p className="text-sm font-medium text-muted-foreground mb-4 uppercase tracking-widest">{title}</p>
          {isLoading ? (
            <div className="h-8 w-16 bg-black/5 rounded animate-pulse" />
          ) : (
            <div className="flex items-end gap-3">
              <h2 className="text-3xl font-bold tracking-tight">{value}</h2>
              <span className="text-sm font-medium text-primary flex items-center mb-1 bg-primary/10 px-2 py-0.5 rounded-full">
                <ArrowUpRight className="w-3 h-3 mr-1" />
                {trend}
              </span>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}