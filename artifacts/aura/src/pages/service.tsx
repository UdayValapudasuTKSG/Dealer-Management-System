import { Link } from "wouter";
import { useListServiceOrders } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Wrench, Calendar, Clock, DollarSign, PenTool } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { motion } from "framer-motion";

export default function Service() {
  const { data: orders, isLoading } = useListServiceOrders();

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-4xl font-light tracking-tight mb-2">Service <span className="font-semibold">Operations</span></h1>
          <p className="text-muted-foreground text-lg">Maintaining excellence in the bays.</p>
        </div>
        <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2 font-medium tracking-wide">
          <Plus className="w-5 h-5" />
          Create Order
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-6">
        {isLoading ? (
          [...Array(4)].map((_, i) => <div key={i} className="h-40 bg-black/5 rounded-3xl animate-pulse" />)
        ) : (
          orders?.map((order, i) => (
            <motion.div
              key={order.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <Card className="glass-panel border-none shadow-sm hover:shadow-xl transition-all duration-300 rounded-3xl overflow-hidden group relative">
                <div className={`absolute top-0 bottom-0 left-0 w-1.5 ${order.status === 'completed' ? 'bg-primary' : 'bg-black/10'}`} />
                <CardContent className="p-6 md:p-8 flex flex-col md:flex-row gap-8 justify-between pl-8 md:pl-10">
                  <div className="flex gap-6 items-start w-full md:w-2/5">
                    <div className="w-16 h-16 rounded-2xl bg-black/5 flex items-center justify-center shrink-0 group-hover:bg-primary/10 transition-colors duration-500">
                      <Wrench className="w-8 h-8 text-muted-foreground group-hover:text-primary transition-colors duration-500" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold tracking-widest text-primary mb-1 uppercase flex items-center gap-2">
                        RO #{order.id.toString().padStart(5, '0')}
                        <span className="w-1 h-1 rounded-full bg-primary" />
                        <span className="text-muted-foreground">{order.type}</span>
                      </div>
                      <h3 className="font-bold text-2xl leading-tight mb-2">{order.vehicleInfo}</h3>
                      <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                        <User className="w-4 h-4" />
                        {order.customerId ? (
                          <Link href={`/customers/${order.customerId}`} className="text-primary hover:underline">{order.customerName || 'Unknown'}</Link>
                        ) : (
                          <span>{order.customerName || 'Unknown'}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-8 w-full md:w-3/5 items-center">
                    <div>
                      <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase flex items-center gap-1.5 mb-2">
                        <Calendar className="w-3.5 h-3.5" /> Scheduled
                      </div>
                      <div className="font-medium text-lg leading-tight">{format(new Date(order.scheduledDate), "MMM d")}</div>
                      <div className="text-sm text-muted-foreground">{format(new Date(order.scheduledDate), "h:mm a")}</div>
                    </div>
                    
                    <div>
                      <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-2">Status</div>
                      <Badge variant="secondary" className="px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest border-none bg-black/5 text-foreground">
                        {order.status.replace('_', ' ')}
                      </Badge>
                    </div>

                    <div>
                      <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase flex items-center gap-1.5 mb-2">
                        <PenTool className="w-3.5 h-3.5" /> Technician
                      </div>
                      <div className="font-medium text-lg">{order.technician || 'Unassigned'}</div>
                    </div>

                    <div className="text-left md:text-right">
                      <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase flex items-center justify-start md:justify-end gap-1.5 mb-2">
                        <DollarSign className="w-3.5 h-3.5" /> Est. Total
                      </div>
                      <div className="font-light text-3xl tracking-tight">${order.estimatedCost.toLocaleString()}</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))
        )}
      </div>
    </div>
  );
}

function User(props: any) {
  return <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
}