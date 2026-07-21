import { useState, useMemo, useEffect, useRef } from "react";
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
import { useMoney } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useViewMode } from "@/hooks/use-view-mode";
import { ViewControls } from "@/components/view-controls";
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
  Search,
  Pencil,
  Plus,
  X,
  ImagePlus,
} from "lucide-react";
import { useUpload } from "@workspace/object-storage-web";
import { motion, AnimatePresence } from "framer-motion";

function powertrainLabel(pt: string) {
  return pt === "EV" ? "Electric" : pt;
}

function img(url?: string | null) {
  if (!url) return undefined;
  return `${import.meta.env.BASE_URL}${url.replace(/^\//, "")}`;
}

/** Gallery entries can be uploaded objects (`/objects/...`, served through
 *  the API's storage route) or regular asset paths (`/vehicles/...`). */
function galleryImg(url?: string | null) {
  if (!url) return undefined;
  if (url.startsWith("/objects/")) return `/api/storage${url}`;
  return img(url);
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
    { name: "vin", label: "VIN (17 characters)", type: "text", span: "half", placeholder: "WBY73AW0XPCK00000A", defaultValue: existing?.vin ?? undefined },
    { name: "engineNumber", label: "Engine Number (17 characters)", type: "text", span: "half", placeholder: "ENG1234567890ABCD", defaultValue: existing?.engineNumber ?? undefined },
    { name: "registration", label: "Registration (e.g. PAB1234)", type: "text", span: "half", placeholder: "PAB1234", defaultValue: existing?.registration ?? undefined },
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
  const { gyd } = useMoney();
  const qc = useQueryClient();
  const { toast } = useToast();
  const createVehicle = useCreateVehicle();
  const [body, setBody] = useState<string>("all");
  const [powertrain, setPowertrain] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Vehicle | null>(null);
  const { density, setDensity, layout, setLayout } = useViewMode("inventory");

  const bodyTypes = useMemo(() => {
    const set = new Set((vehicles ?? []).map((v) => v.bodyType));
    return ["all", ...Array.from(set)];
  }, [vehicles]);

  const powertrains = useMemo(() => {
    const set = new Set((vehicles ?? []).map((v) => v.powertrain));
    return ["all", ...Array.from(set)];
  }, [vehicles]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (vehicles ?? []).filter(
      (v) =>
        (body === "all" || v.bodyType === body) &&
        (powertrain === "all" || v.powertrain === powertrain) &&
        (q === "" ||
          `${v.year} ${v.make} ${v.model} ${v.trim ?? ""}`
            .toLowerCase()
            .includes(q)),
    );
  }, [vehicles, body, powertrain, query]);

  return (
    <div className="h-full overflow-y-auto">
      {/* eatnaked-style centered header */}
      <div className="relative w-full overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage:
              "linear-gradient(to right, rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.05) 1px, transparent 1px)",
            backgroundSize: "56px 56px",
            maskImage:
              "radial-gradient(ellipse 80% 90% at 50% 0%, black 40%, transparent 100%)",
            WebkitMaskImage:
              "radial-gradient(ellipse 80% 90% at 50% 0%, black 40%, transparent 100%)",
          }}
        />
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-72"
          style={{
            background:
              "radial-gradient(ellipse 60% 100% at 50% 0%, rgba(229,9,20,0.12), transparent 70%)",
          }}
        />

        <div className="relative z-10 flex flex-col items-center text-center px-5 pt-12 pb-8">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-foreground/[0.04] px-4 py-1.5 text-xs font-medium tracking-wide text-foreground/80"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-primary" />
            The Showroom
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.08 }}
            className="mt-6 text-5xl md:text-7xl font-semibold tracking-tight leading-[0.95]"
          >
            Discover the Range
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.16 }}
            className="mt-5 text-muted-foreground font-light max-w-xl"
          >
            Every vehicle in stock, ready for delivery anywhere in Guyana.
          </motion.p>

          {/* Search */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.24 }}
            className="mt-8 w-full max-w-xl"
          >
            <div className="relative">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search make, model or year..."
                className="w-full h-14 rounded-full border border-white/15 bg-foreground/[0.04] pl-6 pr-16 text-sm outline-none placeholder:text-muted-foreground focus:border-primary/60 focus:ring-2 focus:ring-primary/20 transition-all"
              />
              <span
                aria-hidden="true"
                className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-primary text-white flex items-center justify-center shadow-lg shadow-primary/40"
              >
                <Search className="w-4 h-4" />
              </span>
            </div>
          </motion.div>

          {/* Category pills */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.32 }}
            className="mt-10 flex flex-wrap items-center justify-center gap-2.5"
          >
            {bodyTypes.map((bt) => (
              <FilterChip
                key={bt}
                active={body === bt}
                onClick={() => setBody(bt)}
                label={bt === "all" ? "All" : bt}
              />
            ))}
          </motion.div>
        </div>
      </div>

      <div className="w-full px-5 md:px-8 py-8 space-y-8">
        {/* Toolbar: powertrain filters, count, view controls, admin actions */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-6">
          <div className="flex flex-wrap items-center gap-2">
            {powertrains.map((pt) => (
              <FilterChip
                key={pt}
                active={powertrain === pt}
                onClick={() => setPowertrain(pt)}
                label={pt === "all" ? "All powertrains" : powertrainLabel(pt)}
                subtle
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <p className="text-sm text-muted-foreground tabular-nums">
              {filtered.length} vehicle{filtered.length === 1 ? "" : "s"}
            </p>
            <ViewControls
              layout={layout}
              onLayoutChange={setLayout}
              density={density}
              onDensityChange={setDensity}
            />
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
        ) : layout === "list" ? (
          <div className="glass-panel rounded-2xl overflow-hidden border border-white/10">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3 font-semibold">Vehicle</th>
                  <th className="px-4 py-3 font-semibold hidden md:table-cell">Powertrain</th>
                  <th className="px-4 py-3 font-semibold hidden md:table-cell">Body</th>
                  <th className="px-4 py-3 font-semibold hidden lg:table-cell">Colour</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold text-right">Price</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((vehicle) => (
                  <tr
                    key={vehicle.id}
                    className="border-b border-white/5 hover:bg-foreground/[0.03] transition-colors cursor-pointer"
                    onClick={() => setSelected(vehicle)}
                  >
                    <td
                      className={`px-4 font-medium ${
                        density === "compact" ? "py-2.5" : "py-3.5"
                      }`}
                    >
                      {vehicle.year} {vehicle.make} {vehicle.model}
                      {vehicle.trim ? (
                        <span className="text-muted-foreground font-normal"> · {vehicle.trim}</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground hidden md:table-cell">
                      {vehicle.powertrain === "EV" ? "Electric" : vehicle.powertrain}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground hidden md:table-cell">
                      {vehicle.bodyType}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground hidden lg:table-cell">
                      {vehicle.exteriorColor}
                    </td>
                    <td className="px-4 py-2">
                      <span className="rounded-full bg-primary/10 text-primary px-2.5 py-0.5 text-xs font-semibold capitalize">
                        {vehicle.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-semibold">
                      {gyd(vehicle.price)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div
            className={`grid grid-cols-1 md:grid-cols-2 ${
              density === "compact"
                ? "lg:grid-cols-4 gap-5"
                : "lg:grid-cols-3 gap-8"
            }`}
          >
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
  const { gyd, usd } = useMoney();
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
                {gyd(vehicle.price)}
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {usd(vehicle.price)}
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
  const [photoIdx, setPhotoIdx] = useState(0);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { gyd, usd } = useMoney();
  const updateVehicle = useUpdateVehicle();
  const { uploadFile } = useUpload();

  const gallery = useMemo(() => {
    if (!vehicle) return [] as string[];
    const all = [vehicle.imageUrl, ...(vehicle.images ?? [])].filter(
      (u): u is string => !!u,
    );
    return [...new Set(all)];
  }, [vehicle]);
  const currentPhoto =
    gallery[Math.min(photoIdx, Math.max(gallery.length - 1, 0))];

  useEffect(() => {
    setPhotoIdx(0);
  }, [vehicle?.id]);

  async function handleFiles(files: FileList | null) {
    if (!vehicle || !files || files.length === 0) return;
    setUploading(true);
    const prevCount = gallery.length;
    try {
      const paths: string[] = [];
      for (const file of Array.from(files)) {
        const resp = await uploadFile(file);
        if (!resp) throw new Error("Upload failed");
        paths.push(resp.objectPath);
      }
      const updated = await updateVehicle.mutateAsync({
        id: vehicle.id,
        data: { images: [...(vehicle.images ?? []), ...paths] },
      });
      qc.invalidateQueries({ queryKey: getListVehiclesQueryKey() });
      onUpdated(updated);
      setMode("photo");
      setPhotoIdx(prevCount);
      toast({
        title: "Photos added",
        description: `${paths.length} photo${paths.length > 1 ? "s" : ""} added to the gallery.`,
      });
    } catch {
      toast({
        title: "Upload failed",
        description: "Could not upload photos. Please try again.",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function removePhoto(path: string) {
    if (!vehicle) return;
    try {
      const updated = await updateVehicle.mutateAsync({
        id: vehicle.id,
        data: { images: (vehicle.images ?? []).filter((p) => p !== path) },
      });
      qc.invalidateQueries({ queryKey: getListVehiclesQueryKey() });
      onUpdated(updated);
      setPhotoIdx(0);
      toast({ title: "Photo removed" });
    } catch {
      toast({ title: "Could not remove photo", variant: "destructive" });
    }
  }

  return (
    <Dialog open={!!vehicle} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-w-5xl w-[95vw] p-0 overflow-hidden border-white/10 bg-background gap-0"
        onCloseAutoFocus={() => setMode("photo")}
      >
        {vehicle && (
          <div className="grid md:grid-cols-2 max-h-[88vh]">
            {/* Visual */}
            <div className="relative bg-black min-h-[280px] md:min-h-full">
              <AnimatePresence mode="wait">
                {mode === "photo" ? (
                  <motion.img
                    key={currentPhoto ?? "photo"}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    src={galleryImg(currentPhoto)}
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

              {/* Gallery thumbnails */}
              {mode === "photo" && gallery.length > 1 && (
                <div className="absolute bottom-16 left-4 right-4 flex gap-2 overflow-x-auto pb-1">
                  {gallery.map((g, i) => (
                    <div key={g} className="relative shrink-0 group/thumb">
                      <button
                        onClick={() => setPhotoIdx(i)}
                        className={
                          i === photoIdx
                            ? "block w-16 h-11 rounded-lg overflow-hidden border border-primary ring-1 ring-primary"
                            : "block w-16 h-11 rounded-lg overflow-hidden border border-white/20 opacity-70 hover:opacity-100 transition-opacity"
                        }
                      >
                        <img
                          src={galleryImg(g)}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                      </button>
                      {canEdit && (vehicle.images ?? []).includes(g) && (
                        <button
                          onClick={() => removePhoto(g)}
                          className="absolute -top-1.5 -right-1.5 hidden group-hover/thumb:flex items-center justify-center w-4 h-4 rounded-full bg-black/80 border border-white/20 text-white hover:bg-primary"
                          aria-label="Remove photo"
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Add photos (staff with inventory edit permission) */}
              {canEdit && (
                <div className="absolute bottom-4 right-4">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => handleFiles(e.target.files)}
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="flex items-center gap-2 rounded-full bg-black/60 backdrop-blur-md border border-white/10 px-4 h-9 text-xs font-medium text-white hover:bg-black/80 transition-colors disabled:opacity-60"
                  >
                    {uploading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <ImagePlus className="w-4 h-4" />
                    )}
                    {uploading ? "Uploading…" : "Add photos"}
                  </button>
                </div>
              )}

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
                  {gyd(vehicle.price)}
                </span>
                <span className="text-xs uppercase tracking-widest text-muted-foreground">
                  {usd(vehicle.price)} OTD est.
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
      <DialogContent className="max-w-md border-white/10 bg-background">
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
