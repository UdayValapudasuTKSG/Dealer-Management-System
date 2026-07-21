import { useState } from "react";
import { useRoute, Link, useLocation } from "wouter";
import { useGetVehicle } from "@workspace/api-client-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  ArrowLeft,
  BadgeCheck,
  Boxes,
  Calendar,
  Cog,
  FileText,
  Fingerprint,
  Fuel,
  Gauge,
  Image as ImageIcon,
  Layers,
  Loader2,
  Package,
  Palette,
  Rotate3d,
  Settings2,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Page } from "@/components/layout/page";
import { cn } from "@/lib/utils";
import { useMoney } from "@/lib/format";

function img(url: string | null | undefined) {
  if (!url) return undefined;
  return url.startsWith("http")
    ? url
    : `${import.meta.env.BASE_URL}${url.replace(/^\//, "")}`;
}

function Spec({
  icon,
  label,
  value,
  mono,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-foreground/[0.03] p-3.5">
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">
        {icon}
        {label}
      </div>
      <div
        className={cn(
          "text-sm font-medium text-foreground break-words",
          mono && "font-mono text-xs tracking-wide",
        )}
      >
        {value}
      </div>
    </div>
  );
}

export default function VehicleDetailPage() {
  const [, params] = useRoute("/vehicle/:id");
  const id = params ? Number(params.id) : NaN;
  const [, navigate] = useLocation();
  const [mode, setMode] = useState<"photo" | "spin">("photo");
  const money = useMoney();

  const { data: vehicle, isLoading, isError } = useGetVehicle(id);

  if (isLoading) {
    return (
      <Page>
        <div className="flex items-center justify-center py-32">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      </Page>
    );
  }

  if (isError || !vehicle) {
    return (
      <Page>
        <div className="text-center py-32 space-y-4">
          <div className="text-lg font-semibold">Vehicle not found</div>
          <Link
            href="/inventory"
            className="text-primary hover:underline text-sm"
          >
            Back to Showroom
          </Link>
        </div>
      </Page>
    );
  }

  const powertrainIcon =
    vehicle.powertrain === "EV" ? (
      <Zap className="w-4 h-4" />
    ) : (
      <Fuel className="w-4 h-4" />
    );

  return (
    <Page className="pb-28">
      <Link
        href="/inventory"
        className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:text-primary transition-colors mb-5"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Showroom
      </Link>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
        {/* Visual */}
        <div className="relative rounded-3xl overflow-hidden border border-white/10 bg-black aspect-[4/3]">
          <AnimatePresence mode="wait">
            {mode === "photo" ? (
              <motion.img
                key="photo"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                src={img(vehicle.imageUrl)}
                alt={`${vehicle.make} ${vehicle.model}`}
                className="absolute inset-0 w-full h-full object-cover"
              />
            ) : (
              <motion.video
                key="spin"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                autoPlay
                muted
                loop
                playsInline
                poster={img(vehicle.imageUrl)}
                className="absolute inset-0 w-full h-full object-cover"
              >
                <source
                  src={`${import.meta.env.BASE_URL}videos/white_luxury_car_showroom_turntable.mp4`}
                  type="video/mp4"
                />
              </motion.video>
            )}
          </AnimatePresence>
          <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent pointer-events-none" />

          <div className="absolute bottom-4 left-4 flex items-center gap-1 rounded-full bg-black/60 backdrop-blur-md border border-white/10 p-1">
            {(["photo", "spin"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  "inline-flex items-center gap-1.5 px-3.5 h-8 rounded-full text-xs font-semibold transition-colors",
                  mode === m
                    ? "bg-primary text-white"
                    : "text-white/70 hover:text-white",
                )}
              >
                {m === "photo" ? (
                  <ImageIcon className="w-3.5 h-3.5" />
                ) : (
                  <Rotate3d className="w-3.5 h-3.5" />
                )}
                {m === "photo" ? "Photo" : "360°"}
              </button>
            ))}
          </div>

          <div className="absolute top-4 left-4 flex gap-2">
            {vehicle.featured && (
              <Badge className="bg-primary text-white text-[10px] font-bold tracking-widest uppercase border-none px-3 py-1">
                Featured
              </Badge>
            )}
            <Badge className="bg-white/10 text-white text-[10px] font-bold tracking-widest uppercase border-none px-3 py-1">
              {vehicle.status.replace("_", " ")}
            </Badge>
          </div>
        </div>

        {/* Details */}
        <div>
          <div className="text-[11px] font-bold uppercase tracking-widest text-primary mb-2">
            {vehicle.bodyType} · {vehicle.year}
          </div>
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight leading-none">
            {vehicle.make} <span className="font-light">{vehicle.model}</span>
          </h1>
          {vehicle.trim && (
            <p className="text-muted-foreground mt-2">{vehicle.trim}</p>
          )}

          <div className="flex items-baseline gap-2 mt-6">
            <span className="text-3xl font-light tracking-tight">
              {money.dual(vehicle.price)}
            </span>
            <span className="text-xs uppercase tracking-widest text-muted-foreground">
              OTD est.
            </span>
          </div>

          {vehicle.description && (
            <p className="text-sm text-muted-foreground leading-relaxed mt-5">
              {vehicle.description}
            </p>
          )}

          <div className="grid grid-cols-2 gap-3 mt-7">
            <Spec
              icon={powertrainIcon}
              label="Powertrain"
              value={
                vehicle.powertrain === "EV" ? "Electric" : vehicle.powertrain
              }
            />
            {vehicle.rangeKm != null ? (
              <Spec
                icon={<Gauge className="w-4 h-4" />}
                label="Range"
                value={`${vehicle.rangeKm} km`}
              />
            ) : (
              <Spec
                icon={<Activity className="w-4 h-4" />}
                label="Mileage"
                value={`${vehicle.mileageKm.toLocaleString()} km`}
              />
            )}
            <Spec
              icon={<Palette className="w-4 h-4" />}
              label="Exterior"
              value={vehicle.exteriorColor}
            />
            <Spec
              icon={<Calendar className="w-4 h-4" />}
              label="Model Year"
              value={String(vehicle.year)}
            />
            <Spec
              icon={<Boxes className="w-4 h-4" />}
              label="Body"
              value={vehicle.bodyType}
            />
            <Spec
              icon={<BadgeCheck className="w-4 h-4" />}
              label="Status"
              value={vehicle.status.replace("_", " ")}
            />
            {vehicle.vin && (
              <Spec
                icon={<Fingerprint className="w-4 h-4" />}
                label="VIN"
                value={vehicle.vin}
                mono
              />
            )}
            {vehicle.variant && (
              <Spec
                icon={<Layers className="w-4 h-4" />}
                label="Variant"
                value={vehicle.variant}
              />
            )}
            {vehicle.engine && (
              <Spec
                icon={<Cog className="w-4 h-4" />}
                label="Engine"
                value={vehicle.engine}
              />
            )}
            {vehicle.transmission && (
              <Spec
                icon={<Settings2 className="w-4 h-4" />}
                label="Transmission"
                value={vehicle.transmission}
              />
            )}
          </div>

          {(vehicle.accessories ?? []).length > 0 && (
            <div className="mt-6">
              <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
                <Package className="w-4 h-4" /> Fitted accessories
              </div>
              <div className="flex flex-wrap gap-2">
                {(vehicle.accessories ?? []).map((a) => (
                  <span
                    key={a}
                    className="px-3 py-1 rounded-full bg-foreground/[0.05] border border-white/10 text-xs"
                  >
                    {a}
                  </span>
                ))}
              </div>
            </div>
          )}

          {(vehicle.documents ?? []).length > 0 && (
            <div className="mt-5">
              <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
                <FileText className="w-4 h-4" /> Documents
              </div>
              <div className="space-y-1.5">
                {(vehicle.documents ?? []).map((d) => (
                  <div
                    key={d.name}
                    className="flex items-center gap-2 rounded-xl border border-white/10 bg-foreground/[0.03] px-3 py-2 text-sm"
                  >
                    <FileText className="w-4 h-4 text-muted-foreground" />
                    <span className="flex-1 truncate">{d.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 mt-8">
            <button
              onClick={() => navigate(`/deals?vehicle=${vehicle.id}`)}
              className="flex-1 min-w-40 h-12 rounded-full bg-primary text-white text-sm font-medium shadow-lg shadow-primary/30 hover:bg-primary/90 transition-colors"
            >
              Structure a deal
            </button>
            <Link
              href="/inventory"
              className="h-12 px-5 rounded-full border border-white/15 text-sm font-medium hover:bg-foreground/[0.05] transition-colors inline-flex items-center gap-2"
            >
              Open in Showroom
            </Link>
          </div>
        </div>
      </div>
      
      {/* Sticky Summary Bar */}
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-xl border-t border-border/50 p-4 transform translate-y-0">
        <div className="container mx-auto max-w-5xl flex items-center justify-between gap-4">
           <div>
             <div className="text-sm font-semibold tracking-tight">{vehicle.make} {vehicle.model}</div>
             <div className="text-xs text-muted-foreground">{vehicle.trim}</div>
           </div>
           <div className="flex items-center gap-6">
             <div className="text-xl font-light tabular-nums hidden sm:block">{money.gyd(vehicle.price)}</div>
             <button onClick={() => navigate(`/deals?vehicle=${vehicle.id}`)} className="h-10 px-8 rounded-full bg-primary text-white text-sm font-medium hover:bg-primary/90 transition-colors shadow-lg shadow-primary/20">
               Structure Deal
             </button>
           </div>
        </div>
      </div>
    </Page>
  );
}
