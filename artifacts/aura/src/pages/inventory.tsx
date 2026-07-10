import { useState, useMemo } from "react";
import { useListVehicles } from "@workspace/api-client-react";
import type { Vehicle } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import {
  CarFront,
  Zap,
  Fuel,
  Activity,
  Gauge,
  ArrowRight,
  ChevronDown,
} from "lucide-react";
import { motion } from "framer-motion";

function powertrainLabel(pt: string) {
  return pt === "EV" ? "Electric" : pt;
}

function img(url?: string | null) {
  if (!url) return undefined;
  return `${import.meta.env.BASE_URL}${url.replace(/^\//, "")}`;
}

function powertrainIcon(pt: string) {
  if (pt === "EV") return <Zap className="w-4 h-4" />;
  if (pt === "Hybrid") return <Activity className="w-4 h-4" />;
  return <Fuel className="w-4 h-4" />;
}

export default function Inventory() {
  const { data: vehicles, isLoading } = useListVehicles();
  const [body, setBody] = useState<string>("all");
  const [powertrain, setPowertrain] = useState<string>("all");

  const bodyTypes = useMemo(() => {
    const set = new Set((vehicles ?? []).map((v) => v.bodyType));
    return ["all", ...Array.from(set)];
  }, [vehicles]);

  const powertrains = useMemo(() => {
    const set = new Set((vehicles ?? []).map((v) => v.powertrain));
    return ["all", ...Array.from(set)];
  }, [vehicles]);

  const featured = useMemo(
    () => (vehicles ?? []).find((v) => v.featured && v.imageUrl) ?? vehicles?.[0],
    [vehicles],
  );

  const filtered = useMemo(
    () =>
      (vehicles ?? []).filter(
        (v) =>
          (body === "all" || v.bodyType === body) &&
          (powertrain === "all" || v.powertrain === powertrain),
      ),
    [vehicles, body, powertrain],
  );

  return (
    <div className="h-full overflow-y-auto">
      {/* Cinematic featured hero */}
      <div className="relative h-[62vh] min-h-[420px] w-full overflow-hidden bg-black">
        {featured?.imageUrl && (
          <motion.img
            key={featured.id}
            initial={{ scale: 1.08, opacity: 0.4 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 1.4, ease: "easeOut" }}
            src={img(featured.imageUrl)}
            alt={`${featured.make} ${featured.model}`}
            className="absolute inset-0 w-full h-full object-cover"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-background via-black/30 to-black/10 z-10" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/60 via-black/10 to-transparent z-10" />

        <div className="relative z-20 h-full max-w-7xl mx-auto px-6 md:px-10 lg:px-14 flex flex-col justify-end pb-16">
          {featured && (
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.3 }}
              className="max-w-2xl"
            >
              <div className="text-xs font-bold uppercase tracking-[0.25em] text-white/70 mb-4">
                The Showroom · Featured
              </div>
              <h1 className="text-5xl md:text-7xl font-semibold tracking-tight text-white leading-[0.95]">
                {featured.make}{" "}
                <span className="font-light">{featured.model}</span>
              </h1>
              {featured.description && (
                <p className="text-lg text-white/80 font-light mt-5 max-w-xl leading-relaxed">
                  {featured.description}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-6 mt-8 text-white">
                <div className="text-3xl font-light tracking-tight">
                  ${featured.price.toLocaleString()}
                </div>
                <div className="h-6 w-px bg-white/30" />
                <div className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-white/80">
                  {powertrainIcon(featured.powertrain)}
                  {featured.powertrain === "EV" ? "Electric" : featured.powertrain}
                </div>
                {featured.rangeKm != null && (
                  <div className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-white/80">
                    <Gauge className="w-4 h-4" />
                    {featured.rangeKm} km range
                  </div>
                )}
              </div>
            </motion.div>
          )}
          <div className="absolute bottom-6 right-6 md:right-14 text-white/50 flex items-center gap-2 text-xs uppercase tracking-widest">
            Explore range
            <ChevronDown className="w-4 h-4 animate-bounce" />
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 md:px-10 lg:px-14 py-12 space-y-10">
        {/* Intro */}
        <div>
          <h2 className="text-3xl md:text-4xl font-semibold tracking-tight">
            Discover the range
          </h2>
          <p className="text-muted-foreground mt-2 font-light max-w-2xl">
            Explore the full lineup ready for delivery and find the vehicle that
            fits perfectly.
          </p>
        </div>

        {/* Filter bar (BMW-style) */}
        <div className="flex flex-col gap-6 border-b border-border/60 pb-6">
          <div className="flex flex-wrap items-center gap-2">
            {bodyTypes.map((bt) => (
              <FilterChip
                key={bt}
                active={body === bt}
                onClick={() => setBody(bt)}
                label={bt === "all" ? "All models" : bt}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              {powertrains.map((pt) => (
                <FilterChip
                  key={pt}
                  active={powertrain === pt}
                  onClick={() => setPowertrain(pt)}
                  label={pt === "all" ? "All" : powertrainLabel(pt)}
                  subtle
                />
              ))}
            </div>
            <p className="text-sm text-muted-foreground tabular-nums">
              {filtered.length} vehicle{filtered.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>

        {/* Grid */}
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-[380px] bg-black/5 rounded-3xl animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-24 text-muted-foreground">
            <CarFront className="w-12 h-12 mx-auto mb-4 opacity-20" />
            <p className="font-medium">No vehicles match these filters.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {filtered.map((vehicle, i) => (
              <VehicleCard key={vehicle.id} vehicle={vehicle} delay={i * 0.05} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  subtle,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  subtle?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`px-5 h-10 rounded-full text-sm font-medium tracking-wide transition-all duration-300 ${
        active
          ? "bg-primary text-white shadow-lg shadow-primary/20"
          : subtle
            ? "bg-transparent text-muted-foreground hover:text-foreground border border-border/60 hover:border-foreground/30"
            : "bg-black/5 text-foreground hover:bg-black/10"
      }`}
    >
      {label}
    </button>
  );
}

function VehicleCard({ vehicle, delay }: { vehicle: Vehicle; delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.5 }}
    >
      <div className="group cursor-pointer rounded-3xl overflow-hidden bg-white border border-border/60 hover:border-primary/30 hover:shadow-2xl transition-all duration-500 h-full flex flex-col">
        <div className="relative h-56 overflow-hidden bg-gradient-to-b from-black/5 to-black/10">
          {vehicle.imageUrl ? (
            <img
              src={img(vehicle.imageUrl)}
              alt={`${vehicle.year} ${vehicle.make} ${vehicle.model}`}
              className="w-full h-full object-cover transform group-hover:scale-105 transition-transform duration-700 ease-out"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <CarFront className="w-20 h-20 text-black/10" />
            </div>
          )}
          <div className="absolute top-4 left-4 flex gap-2">
            {vehicle.featured && (
              <Badge className="bg-primary text-white text-[10px] font-bold tracking-widest uppercase border-none px-3 py-1">
                Featured
              </Badge>
            )}
            <Badge
              variant="secondary"
              className="bg-white/90 backdrop-blur-md text-[10px] font-bold tracking-widest uppercase shadow-sm px-3 py-1 border-none text-foreground"
            >
              {vehicle.status.replace("_", " ")}
            </Badge>
          </div>
        </div>

        <div className="p-6 flex-1 flex flex-col">
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
            <span>{vehicle.bodyType}</span>
            <span className="w-1 h-1 rounded-full bg-border" />
            <span>{vehicle.year}</span>
          </div>
          <h3 className="text-2xl font-semibold tracking-tight leading-tight group-hover:text-primary transition-colors duration-300">
            {vehicle.make} <span className="font-light">{vehicle.model}</span>
          </h3>
          {vehicle.trim && (
            <p className="text-sm text-muted-foreground mt-1">{vehicle.trim}</p>
          )}

          <div className="flex items-center gap-5 mt-5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <span className="flex items-center gap-1.5">
              {powertrainIcon(vehicle.powertrain)}
              {vehicle.powertrain === "EV" ? "Electric" : vehicle.powertrain}
            </span>
            {vehicle.rangeKm != null ? (
              <span className="flex items-center gap-1.5">
                <Gauge className="w-4 h-4" />
                {vehicle.rangeKm} km
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <Activity className="w-4 h-4" />
                {vehicle.mileageKm.toLocaleString()} km
              </span>
            )}
          </div>

          <div className="flex items-end justify-between mt-6 pt-5 border-t border-border/60">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
                Price
              </p>
              <p className="text-2xl font-light tracking-tight">
                ${vehicle.price.toLocaleString()}
              </p>
            </div>
            <div className="w-11 h-11 rounded-full bg-black/5 group-hover:bg-primary group-hover:text-white flex items-center justify-center transition-all duration-300">
              <ArrowRight className="w-5 h-5" />
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
