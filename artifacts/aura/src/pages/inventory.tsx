import { useListVehicles } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CarFront, Plus, Zap, Fuel, Activity } from "lucide-react";
import { motion } from "framer-motion";

export default function Inventory() {
  const { data: vehicles, isLoading } = useListVehicles();

  const getPowertrainIcon = (pt: string) => {
    switch (pt) {
      case "EV": return <Zap className="w-4 h-4" />;
      case "Hybrid": return <Activity className="w-4 h-4" />;
      default: return <Fuel className="w-4 h-4" />;
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-4xl font-light tracking-tight mb-2">Showroom <span className="font-semibold">Inventory</span></h1>
          <p className="text-muted-foreground text-lg">Curated excellence ready for delivery.</p>
        </div>
        <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2 font-medium tracking-wide">
          <Plus className="w-5 h-5" />
          Acquire Vehicle
        </Button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-[400px] bg-black/5 rounded-3xl animate-pulse"></div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
          {vehicles?.map((vehicle, i) => (
            <motion.div
              key={vehicle.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <Card className="glass-panel border-none overflow-hidden group cursor-pointer hover:shadow-2xl transition-all duration-500 h-full flex flex-col rounded-3xl">
                <div className="h-56 bg-gradient-to-b from-black/5 to-transparent flex items-center justify-center relative overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent z-10" />
                  {vehicle.imageUrl ? (
                    <img 
                      src={`${import.meta.env.BASE_URL}${vehicle.imageUrl.replace(/^\//, '')}`} 
                      alt={`${vehicle.year} ${vehicle.make} ${vehicle.model}`} 
                      className="w-full h-full object-cover transform group-hover:scale-105 transition-transform duration-700 ease-out" 
                    />
                  ) : (
                    <CarFront className="w-20 h-20 text-black/10 transform group-hover:scale-110 transition-transform duration-700" />
                  )}
                  <div className="absolute top-4 left-4 z-20">
                    <Badge variant="secondary" className="bg-white/90 backdrop-blur-md text-xs font-bold tracking-wider uppercase shadow-lg px-3 py-1 border-none text-foreground">
                      {vehicle.status.replace('_', ' ')}
                    </Badge>
                  </div>
                </div>
                <CardContent className="p-6 flex-1 flex flex-col justify-between relative z-20 bg-white/50 backdrop-blur-md">
                  <div className="mb-6">
                    <div className="text-sm font-semibold tracking-widest text-primary mb-1 uppercase">{vehicle.year}</div>
                    <h3 className="font-bold text-2xl leading-tight group-hover:text-primary transition-colors duration-300">
                      {vehicle.make} <span className="font-light">{vehicle.model}</span>
                    </h3>
                  </div>
                  
                  <div>
                    <div className="font-light text-3xl mb-6 tracking-tight">${vehicle.price.toLocaleString()}</div>
                    
                    <div className="flex items-center gap-6 pt-4 border-t border-border/50 text-sm font-medium text-muted-foreground uppercase tracking-wider">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-black/5 flex items-center justify-center text-foreground">
                          {getPowertrainIcon(vehicle.powertrain)}
                        </div>
                        {vehicle.powertrain}
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-black/5 flex items-center justify-center text-foreground">
                          <Activity className="w-4 h-4" />
                        </div>
                        {vehicle.mileageKm.toLocaleString()} KM
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}