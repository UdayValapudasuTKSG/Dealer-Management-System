import { useListServiceOrders } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Wrench, Calendar, Clock, DollarSign } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";

export default function Service() {
  const { data: orders, isLoading } = useListServiceOrders();

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Service & Repairs</h1>
          <p className="text-muted-foreground">Service bay schedule and repair orders</p>
        </div>
        <Button className="gap-2">
          <Plus className="w-4 h-4" />
          Create Repair Order
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {isLoading ? (
          [...Array(4)].map((_, i) => <div key={i} className="h-32 bg-muted rounded-xl animate-pulse" />)
        ) : (
          orders?.map((order) => (
            <Card key={order.id} className="hover-elevate transition-all border-border">
              <CardContent className="p-4 md:p-6 flex flex-col md:flex-row gap-6 justify-between">
                <div className="flex gap-4 items-start w-full md:w-1/3">
                  <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center shrink-0">
                    <Wrench className="w-6 h-6 text-muted-foreground" />
                  </div>
                  <div>
                    <h3 className="font-bold text-lg mb-1">RO #{order.id.toString().padStart(4, '0')}</h3>
                    <div className="text-sm font-medium">{order.vehicleInfo}</div>
                    <div className="text-sm text-muted-foreground">{order.customerName || 'Unknown'}</div>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-6 w-full md:w-2/3 items-center">
                  <div>
                    <div className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
                      <Calendar className="w-3 h-3" /> Scheduled
                    </div>
                    <div className="text-sm font-medium">{format(new Date(order.scheduledDate), "MMM d, h:mm a")}</div>
                  </div>
                  
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Type</div>
                    <Badge variant="outline" className="capitalize">{order.type}</Badge>
                  </div>
                  
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Status</div>
                    <Badge className="capitalize bg-primary/10 text-primary hover:bg-primary/20 border-0">
                      {order.status.replace('_', ' ')}
                    </Badge>
                  </div>

                  <div className="text-right">
                    <div className="text-xs text-muted-foreground flex items-center justify-end gap-1 mb-1">
                      <DollarSign className="w-3 h-3" /> Est. Cost
                    </div>
                    <div className="font-bold text-lg">${order.estimatedCost.toLocaleString()}</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}