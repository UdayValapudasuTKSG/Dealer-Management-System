import { useListVehicles } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CarFront, Plus, Zap, Fuel, Activity } from "lucide-react";

export default function Inventory() {
  const { data: vehicles, isLoading } = useListVehicles();

  const getPowertrainIcon = (pt: string) => {
    switch (pt) {
      case "EV": return <Zap className="w-4 h-4 text-primary" />;
      case "Hybrid": return <Activity className="w-4 h-4 text-emerald-500" />;
      default: return <Fuel className="w-4 h-4 text-slate-500" />;
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Inventory</h1>
          <p className="text-muted-foreground">Manage dealership vehicles and stock</p>
        </div>
        <Button className="gap-2">
          <Plus className="w-4 h-4" />
          Add Vehicle
        </Button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-[300px] bg-muted rounded-xl animate-pulse"></div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {vehicles?.map((vehicle) => (
            <Card key={vehicle.id} className="overflow-hidden hover-elevate group cursor-pointer transition-all border-border">
              <div className="h-48 bg-secondary flex items-center justify-center relative">
                {vehicle.imageUrl ? (
                  <img src={vehicle.imageUrl} alt={`${vehicle.year} ${vehicle.make} ${vehicle.model}`} className="w-full h-full object-cover" />
                ) : (
                  <CarFront className="w-16 h-16 text-muted-foreground/30" />
                )}
                <div className="absolute top-3 left-3 flex gap-2">
                  <Badge variant="secondary" className="bg-white/90 backdrop-blur text-xs font-semibold shadow-sm">
                    {vehicle.status.toUpperCase()}
                  </Badge>
                </div>
              </div>
              <CardContent className="p-5">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <div className="text-sm text-muted-foreground">{vehicle.year}</div>
                    <h3 className="font-bold text-lg leading-tight group-hover:text-primary transition-colors">
                      {vehicle.make} {vehicle.model}
                    </h3>
                  </div>
                  <div className="text-right">
                    <div className="font-bold text-lg">${vehicle.price.toLocaleString()}</div>
                  </div>
                </div>
                
                <div className="flex items-center gap-4 mt-4 pt-4 border-t border-border/50 text-sm text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    {getPowertrainIcon(vehicle.powertrain)}
                    <span>{vehicle.powertrain}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span>{vehicle.mileageKm.toLocaleString()} km</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          {vehicles?.length === 0 && (
            <div className="col-span-full py-12 text-center text-muted-foreground border-2 border-dashed border-border rounded-xl">
              <CarFront className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <h3 className="text-lg font-medium text-foreground mb-1">No vehicles in stock</h3>
              <p>Add some vehicles to your inventory to get started.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}