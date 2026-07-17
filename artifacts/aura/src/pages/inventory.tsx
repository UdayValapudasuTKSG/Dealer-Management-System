import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListVehicles,
  useCreateBooking,
  useCreateVehicle,
  useUpdateVehicle,
  getListVehiclesQueryKey,
  getListBookingsQueryKey,
} from "@workspace/api-client-react";
import type { Vehicle } from "@workspace/api-client-react";
import { CreateRecordDialog, type FieldDef } from "@/components/create-record-dialog";
import { ImportVehiclesDialog } from "@/components/inventory/import-vehicles-dialog";
import { Button } from "@/components/ui/button";
import { useAuthz } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  CarFront,
  Zap,
  Fuel,
  Activity,
  Gauge,
  ArrowRight,
  ChevronDown,
  Rotate3d,
  Image as ImageIcon,
  Palette,
  Calendar,
  Boxes,
  BadgeCheck,
  Fingerprint,
  Cog,
  Settings2,
  Layers,
  Package,
  FileSpreadsheet,
  FileText,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

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

const BODY_TYPES = [
  "SUV",
  "Sedan",
  "Coupe",
  "Hatchback",
  "Convertible",
  "Wagon",
  "Pickup",
  "Van",
];

const STATUS_LABELS: Record<string, string> = {
  available: "Available",
  reserved: "Reserved",
  booked: "Booked",
  delivered: "Delivered",
  in_transit: "In transit",
  sold: "Sold",
  service: "In service",
};

/** Mirrors the server's stock lifecycle (VEHICLE_STATUS_TRANSITIONS in @workspace/db). */
const STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  available: ["reserved", "booked", "in_transit", "service", "sold"],
  reserved: ["booked", "available"],
  booked: ["delivered", "available"],
  delivered: [],
  in_transit: ["available"],
  service: ["available"],
  sold: [],
};

function vehicleFields(existing?: Vehicle): FieldDef[] {
  const bodyOptions = Array.from(
    new Set([...BODY_TYPES, ...(existing?.bodyType ? [existing.bodyType] : [])]),
  ).map((b) => ({ value: b, label: b }));

  const statusValues = existing
    ? [existing.status, ...(STATUS_TRANSITIONS[existing.status] ?? [])]
    : ["available", "in_transit", "service"];
  const statusOptions = statusValues.map((s) => ({
    value: s,
    label: STATUS_LABELS[s] ?? s,
  }));

  return [
    { name: "make", label: "Make", type: "text", required: true, span: "half", placeholder: "BMW", defaultValue: existing?.make },
    { name: "model", label: "Model", type: "text", required: true, span: "half", placeholder: "i7", defaultValue: existing?.model },
    { name: "trim", label: "Trim", type: "text", span: "half", placeholder: "xDrive60 M Sport", defaultValue: existing?.trim ?? undefined },
    { name: "year", label: "Year", type: "number", required: true, span: "half", placeholder: "2026", defaultValue: existing ? String(existing.year) : undefined },
    { name: "vin", label: "VIN", type: "text", span: "half", placeholder: "WBY73AW0XPCK00000", defaultValue: existing?.vin ?? undefined },
    { name: "price", label: "Price ($)", type: "number", required: true, span: "half", placeholder: "125000", defaultValue: existing ? String(existing.price) : undefined },
    {
      name: "powertrain",
      label: "Powertrain",
      type: "select",
      required: true,
      span: "half",
      defaultValue: existing?.powertrain ?? "Petrol",
      options: [
        { value: "EV", label: "Electric" },
        { value: "Hybrid", label: "Hybrid" },
        { value: "Petrol", label: "Petrol" },
        { value: "Diesel", label: "Diesel" },
      ],
    },
    { name: "rangeKm", label: "Range (km)", type: "number", span: "half", placeholder: "610", defaultValue: existing?.rangeKm != null ? String(existing.rangeKm) : undefined },
    { name: "mileageKm", label: "Mileage (km)", type: "number", required: true, span: "half", placeholder: "0", defaultValue: existing ? String(existing.mileageKm) : "0" },
    { name: "exteriorColor", label: "Exterior color", type: "text", required: true, span: "half", placeholder: "Obsidian Black", defaultValue: existing?.exteriorColor },
    {
      name: "bodyType",
      label: "Body type",
      type: "select",
      required: true,
      span: "half",
      defaultValue: existing?.bodyType,
      options: bodyOptions,
    },
    { name: "engine", label: "Engine", type: "text", span: "half", placeholder: "4.4L V8 TwinPower", defaultValue: existing?.engine ?? undefined },
    { name: "transmission", label: "Transmission", type: "text", span: "half", placeholder: "8-speed automatic", defaultValue: existing?.transmission ?? undefined },
    {
      name: "status",
      label: "Status",
      type: "select",
      span: "half",
      defaultValue: existing?.status ?? "available",
      options: statusOptions,
    },
    { name: "imageUrl", label: "Image URL", type: "text", span: "full", placeholder: "/vehicles/bmw-i7.png", defaultValue: existing?.imageUrl ?? undefined },
  ];
}

export default function Inventory() {
  const { data: vehicles, isLoading } = useListVehicles();
  const { can } = useAuthz();
  const qc = useQueryClient();
  const { toast } = useToast();
  const createVehicle = useCreateVehicle();
  const [body, setBody] = useState<string>("all");
  const [powertrain, setPowertrain] = useState<string>("all");
  const [selected, setSelected] = useState<Vehicle | null>(null);

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
        <div className="absolute inset-0 bg-gradient-to-t from-background via-black/40 to-black/20 z-10" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/70 via-black/20 to-transparent z-10" />

        <div className="relative z-20 h-full w-full px-5 md:px-8 flex flex-col justify-end pb-16">
          {featured && (
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.3 }}
              className="max-w-2xl"
            >
              <div className="text-xs font-bold uppercase tracking-[0.25em] text-primary mb-4 text-glow">
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
              <button
                onClick={() => setSelected(featured)}
                className="group mt-8 inline-flex items-center gap-2 h-12 px-7 rounded-full bg-primary text-white text-sm font-medium shadow-lg shadow-primary/30 hover:bg-primary/90 transition-all duration-300"
              >
                View 360° & details
                <Rotate3d className="w-4 h-4 transition-transform duration-500 group-hover:rotate-180" />
              </button>
            </motion.div>
          )}
          <div className="absolute bottom-6 right-6 md:right-14 text-white/50 flex items-center gap-2 text-xs uppercase tracking-widest">
            Explore range
            <ChevronDown className="w-4 h-4 animate-bounce" />
          </div>
        </div>
      </div>

      <div className="w-full px-5 md:px-8 py-8 space-y-8">
        {/* Intro */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-3xl md:text-4xl font-semibold tracking-tight">
              Discover the range
            </h2>
            <p className="text-muted-foreground mt-2 font-light max-w-2xl">
              Explore the full lineup ready for delivery and find the vehicle that
              fits perfectly.
            </p>
          </div>
          {can("inventory", "create") && (
            <div className="flex flex-wrap items-center gap-3">
            <ImportVehiclesDialog
              trigger={
                <Button
                  variant="outline"
                  className="rounded-full px-6 h-12 gap-2 font-medium tracking-wide border-white/15 bg-foreground/[0.03] hover:bg-foreground/[0.07]"
                >
                  <FileSpreadsheet className="w-5 h-5 text-primary" />
                  Import Excel
                </Button>
              }
            />
            <CreateRecordDialog
              title="Add Vehicle"
              description="Add a new car to the showroom inventory."
              pending={createVehicle.isPending}
              submitLabel="Add to inventory"
              trigger={
                <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2 font-medium tracking-wide">
                  <Plus className="w-5 h-5" />
                  Add Vehicle
                </Button>
              }
              fields={vehicleFields()}
              onSubmit={async (values) => {
                try {
                  const created = await createVehicle.mutateAsync({
                    data: values as never,
                  });
                  qc.invalidateQueries({ queryKey: getListVehiclesQueryKey() });
                  toast({
                    title: "Vehicle added",
                    description: `${created.year} ${created.make} ${created.model} is now in the showroom.`,
                  });
                } catch (err) {
                  toast({
                    title: "Could not add vehicle",
                    description:
                      (err as { response?: { data?: { error?: string } } })
                        ?.response?.data?.error ?? "Something went wrong.",
                    variant: "destructive",
                  });
                  throw err;
                }
              }}
            />
            </div>
          )}
        </div>

        {/* Filter bar (BMW-style) */}
        <div className="flex flex-col gap-6 border-b border-border pb-6">
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
              <div key={i} className="h-[380px] bg-white/[0.03] rounded-3xl animate-pulse" />
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
              <VehicleCard
                key={vehicle.id}
                vehicle={vehicle}
                delay={i * 0.05}
                onSelect={() => setSelected(vehicle)}
              />
            ))}
          </div>
        )}
      </div>

      <VehicleDetail
        vehicle={selected}
        onClose={() => setSelected(null)}
        canEdit={can("inventory", "update")}
        onUpdated={(v) => setSelected(v)}
      />
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
          ? "bg-primary text-white shadow-lg shadow-primary/30"
          : subtle
            ? "bg-transparent text-muted-foreground hover:text-foreground border border-border hover:border-foreground/30"
            : "bg-white/[0.05] text-foreground hover:bg-white/[0.1]"
      }`}
    >
      {label}
    </button>
  );
}

function VehicleCard({
  vehicle,
  delay,
  onSelect,
}: {
  vehicle: Vehicle;
  delay: number;
  onSelect: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.5 }}
    >
      <button
        onClick={onSelect}
        className="group text-left w-full cursor-pointer rounded-3xl overflow-hidden bg-white/[0.03] backdrop-blur-sm border border-white/10 hover:border-primary/50 hover:shadow-2xl hover:shadow-primary/10 transition-all duration-500 h-full flex flex-col"
      >
        <div className="relative h-56 overflow-hidden bg-gradient-to-b from-white/[0.02] to-black/40">
          {vehicle.imageUrl ? (
            <img
              src={img(vehicle.imageUrl)}
              alt={`${vehicle.year} ${vehicle.make} ${vehicle.model}`}
              className="w-full h-full object-cover transform group-hover:scale-105 transition-transform duration-700 ease-out"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <CarFront className="w-20 h-20 text-foreground/10" />
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 text-white text-xs font-semibold uppercase tracking-widest opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-500">
            <Rotate3d className="w-4 h-4" /> 360° & details
          </div>
          <div className="absolute top-4 left-4 flex gap-2">
            {vehicle.featured && (
              <Badge className="bg-primary text-white text-[10px] font-bold tracking-widest uppercase border-none px-3 py-1">
                Featured
              </Badge>
            )}
            <Badge
              variant="secondary"
              className="bg-white/10 backdrop-blur-md text-[10px] font-bold tracking-widest uppercase shadow-sm px-3 py-1 border-none text-white"
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

          <div className="flex items-end justify-between mt-6 pt-5 border-t border-border">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
                Price
              </p>
              <p className="text-2xl font-light tracking-tight">
                ${vehicle.price.toLocaleString()}
              </p>
            </div>
            <div className="w-11 h-11 rounded-full bg-white/[0.06] group-hover:bg-primary group-hover:text-white flex items-center justify-center transition-all duration-300">
              <ArrowRight className="w-5 h-5" />
            </div>
          </div>
        </div>
      </button>
    </motion.div>
  );
}

function VehicleDetail({
  vehicle,
  onClose,
  canEdit,
  onUpdated,
}: {
  vehicle: Vehicle | null;
  onClose: () => void;
  canEdit: boolean;
  onUpdated: (v: Vehicle) => void;
}) {
  const [mode, setMode] = useState<"photo" | "spin">("photo");
  const [reserving, setReserving] = useState(false);
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const updateVehicle = useUpdateVehicle();

  return (
    <Dialog open={!!vehicle} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-w-5xl w-[95vw] p-0 overflow-hidden border-white/10 bg-[#0b0b0b] gap-0"
        onCloseAutoFocus={() => setMode("photo")}
      >
        {vehicle && (
          <div className="grid md:grid-cols-2 max-h-[88vh]">
            {/* Visual */}
            <div className="relative bg-black min-h-[280px] md:min-h-full">
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

              {/* View toggle */}
              <div className="absolute bottom-4 left-4 flex items-center gap-1 rounded-full bg-black/60 backdrop-blur-md border border-white/10 p-1">
                <ViewToggle
                  active={mode === "photo"}
                  onClick={() => setMode("photo")}
                  icon={<ImageIcon className="w-4 h-4" />}
                  label="Photo"
                />
                <ViewToggle
                  active={mode === "spin"}
                  onClick={() => setMode("spin")}
                  icon={<Rotate3d className="w-4 h-4" />}
                  label="360°"
                />
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
            <div className="p-8 overflow-y-auto">
              <button
                onClick={onClose}
                className="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/[0.06] hover:bg-white/[0.12] flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>

              <div className="text-[11px] font-bold uppercase tracking-widest text-primary mb-2">
                {vehicle.bodyType} · {vehicle.year}
              </div>
              <DialogTitle className="text-4xl font-semibold tracking-tight leading-none">
                {vehicle.make}{" "}
                <span className="font-light">{vehicle.model}</span>
              </DialogTitle>
              {vehicle.trim && (
                <p className="text-muted-foreground mt-2">{vehicle.trim}</p>
              )}

              <div className="flex items-baseline gap-2 mt-6">
                <span className="text-3xl font-light tracking-tight">
                  ${vehicle.price.toLocaleString()}
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
                <Spec icon={powertrainIcon(vehicle.powertrain)} label="Powertrain" value={vehicle.powertrain === "EV" ? "Electric" : vehicle.powertrain} />
                {vehicle.rangeKm != null ? (
                  <Spec icon={<Gauge className="w-4 h-4" />} label="Range" value={`${vehicle.rangeKm} km`} />
                ) : (
                  <Spec icon={<Activity className="w-4 h-4" />} label="Mileage" value={`${vehicle.mileageKm.toLocaleString()} km`} />
                )}
                <Spec icon={<Palette className="w-4 h-4" />} label="Exterior" value={vehicle.exteriorColor} />
                <Spec icon={<Calendar className="w-4 h-4" />} label="Model Year" value={String(vehicle.year)} />
                <Spec icon={<Boxes className="w-4 h-4" />} label="Body" value={vehicle.bodyType} />
                <Spec icon={<BadgeCheck className="w-4 h-4" />} label="Status" value={vehicle.status.replace("_", " ")} />
                {vehicle.vin && (
                  <Spec icon={<Fingerprint className="w-4 h-4" />} label="VIN" value={vehicle.vin} mono />
                )}
                {vehicle.variant && (
                  <Spec icon={<Layers className="w-4 h-4" />} label="Variant" value={vehicle.variant} />
                )}
                {vehicle.engine && (
                  <Spec icon={<Cog className="w-4 h-4" />} label="Engine" value={vehicle.engine} />
                )}
                {vehicle.transmission && (
                  <Spec icon={<Settings2 className="w-4 h-4" />} label="Transmission" value={vehicle.transmission} />
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
                        className="px-3 py-1 rounded-full bg-white/[0.05] border border-white/10 text-xs"
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
                        className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm"
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
                  onClick={() => {
                    onClose();
                    navigate(`/deals?vehicle=${vehicle.id}`);
                  }}
                  className="flex-1 min-w-40 h-12 rounded-full bg-primary text-white text-sm font-medium shadow-lg shadow-primary/30 hover:bg-primary/90 transition-colors"
                >
                  Structure a deal
                </button>
                {vehicle.status === "available" && (
                  <button
                    onClick={() => setReserving(true)}
                    className="h-12 px-5 rounded-full border border-primary/40 text-primary text-sm font-medium hover:bg-primary/10 transition-colors inline-flex items-center gap-2"
                  >
                    <KeyRound className="w-4 h-4" /> Reserve
                  </button>
                )}
                <button
                  onClick={() => setMode(mode === "spin" ? "photo" : "spin")}
                  className="h-12 px-5 rounded-full border border-white/15 text-sm font-medium hover:bg-white/[0.05] transition-colors inline-flex items-center gap-2"
                >
                  <Rotate3d className="w-4 h-4" />
                  {mode === "spin" ? "Photo" : "360°"}
                </button>
                {canEdit && (
                  <CreateRecordDialog
                    title="Edit Vehicle"
                    description={`Update details for the ${vehicle.year} ${vehicle.make} ${vehicle.model}.`}
                    pending={updateVehicle.isPending}
                    submitLabel="Save changes"
                    trigger={
                      <button className="h-12 px-5 rounded-full border border-white/15 text-sm font-medium hover:bg-white/[0.05] transition-colors inline-flex items-center gap-2">
                        <Pencil className="w-4 h-4" /> Edit
                      </button>
                    }
                    fields={vehicleFields(vehicle)}
                    onSubmit={async (values) => {
                      try {
                        const updated = await updateVehicle.mutateAsync({
                          id: vehicle.id,
                          data: values as never,
                        });
                        qc.invalidateQueries({
                          queryKey: getListVehiclesQueryKey(),
                        });
                        onUpdated(updated);
                        toast({
                          title: "Vehicle updated",
                          description: `${updated.year} ${updated.make} ${updated.model} has been saved.`,
                        });
                      } catch (err) {
                        toast({
                          title: "Could not update vehicle",
                          description:
                            (err as { response?: { data?: { error?: string } } })
                              ?.response?.data?.error ?? "Something went wrong.",
                          variant: "destructive",
                        });
                        throw err;
                      }
                    }}
                  />
                )}
              </div>

              <ReserveDialog
                vehicle={vehicle}
                open={reserving}
                onClose={() => setReserving(false)}
                onReserved={onClose}
              />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ViewToggle({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-full text-xs font-semibold tracking-wide transition-colors ${
        active ? "bg-primary text-white" : "text-white/70 hover:text-white"
      }`}
    >
      {icon}
      {label}
    </button>
  );
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
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center gap-2 text-muted-foreground text-[10px] font-bold uppercase tracking-widest mb-1.5">
        {icon}
        {label}
      </div>
      <div
        className={`text-sm font-medium ${mono ? "font-mono tracking-tight break-all" : "capitalize"}`}
      >
        {value}
      </div>
    </div>
  );
}

function ReserveDialog({
  vehicle,
  open,
  onClose,
  onReserved,
}: {
  vehicle: Vehicle;
  open: boolean;
  onClose: () => void;
  onReserved: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const createBooking = useCreateBooking();
  const [customerName, setCustomerName] = useState("");
  const [bookingAmount, setBookingAmount] = useState("1000");
  const [amountPaid, setAmountPaid] = useState("0");
  const defaultExpiry = new Date(Date.now() + 7 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);

  const submit = () => {
    if (!customerName.trim()) {
      toast({ title: "Customer name is required", variant: "destructive" });
      return;
    }
    createBooking.mutate(
      {
        data: {
          vehicleId: vehicle.id,
          customerName: customerName.trim(),
          bookingAmount: Number(bookingAmount) || 0,
          amountPaid: Number(amountPaid) || 0,
          expiresAt: new Date(`${expiresAt}T23:59:59`).toISOString(),
        },
      },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListVehiclesQueryKey() });
          qc.invalidateQueries({ queryKey: getListBookingsQueryKey() });
          toast({
            title: "Vehicle reserved",
            description: `${vehicle.year} ${vehicle.make} ${vehicle.model} is on hold for ${customerName.trim()}.`,
          });
          onClose();
          onReserved();
        },
        onError: (err: unknown) =>
          toast({
            title: "Could not reserve",
            description:
              (err as { response?: { data?: { error?: string } } })?.response
                ?.data?.error ?? "Something went wrong.",
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md border-white/10 bg-[#0d0d0d]">
        <DialogTitle className="text-2xl font-semibold tracking-tight">
          Reserve this vehicle
        </DialogTitle>
        <p className="text-sm text-muted-foreground -mt-1">
          {vehicle.year} {vehicle.make} {vehicle.model}
          {vehicle.vin ? ` · ${vehicle.vin}` : ""}
        </p>
        <div className="space-y-3 mt-2">
          <div>
            <label className="text-xs uppercase tracking-widest text-muted-foreground">
              Customer name
            </label>
            <Input
              className="mt-1.5"
              placeholder="Full name"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs uppercase tracking-widest text-muted-foreground">
                Booking amount ($)
              </label>
              <Input
                className="mt-1.5"
                type="number"
                min={0}
                value={bookingAmount}
                onChange={(e) => setBookingAmount(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs uppercase tracking-widest text-muted-foreground">
                Paid now ($)
              </label>
              <Input
                className="mt-1.5"
                type="number"
                min={0}
                value={amountPaid}
                onChange={(e) => setAmountPaid(e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="text-xs uppercase tracking-widest text-muted-foreground">
              Hold until
            </label>
            <Input
              className="mt-1.5"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </div>
          <button
            onClick={submit}
            disabled={createBooking.isPending}
            className="w-full h-12 rounded-full bg-primary text-white text-sm font-medium shadow-lg shadow-primary/30 hover:bg-primary/90 transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-2"
          >
            {createBooking.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <KeyRound className="w-4 h-4" />
            )}
            Confirm reservation
          </button>
          <p className="text-xs text-muted-foreground text-center">
            The vehicle is held until the expiry date, then auto-released if
            unpaid.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
