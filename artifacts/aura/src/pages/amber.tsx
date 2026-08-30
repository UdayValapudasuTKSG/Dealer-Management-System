import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAmberSettings,
  useUpdateAmberSettings,
  useTestAmberConnection,
  useRotateAmberWebhookSecret,
  useListAmberDevices,
  useRegisterAmberDevice,
  useMapAmberDevice,
  useUnmapAmberDevice,
  useListAmberFleetState,
  useListAmberEvents,
  useListVehicles,
  getGetAmberSettingsQueryKey,
  getListAmberDevicesQueryKey,
  getListAmberFleetStateQueryKey,
  getListAmberEventsQueryKey,
} from "@workspace/api-client-react";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuthz } from "@/lib/auth";
import { formatGuyanaDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import {
  Radio,
  Loader2,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Copy,
  KeyRound,
  Link2,
  Unlink,
  Plus,
  Clock,
  Activity,
  AlertTriangle,
  Car,
  MapPin,
  Power,
  Cable,
  ShieldCheck,
  Settings2,
  Database,
  Cpu,
} from "lucide-react";

const FRESHNESS_STYLE: Record<string, { dot: string; bg: string }> = {
  live: { dot: "bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.6)]", bg: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30" },
  recent: { dot: "bg-emerald-500", bg: "bg-emerald-500/5 text-emerald-600 dark:text-emerald-400 border-emerald-500/20" },
  stale: { dot: "bg-amber-500", bg: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30" },
  offline: { dot: "bg-red-500", bg: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30" },
  never: { dot: "bg-muted-foreground", bg: "bg-foreground/5 text-muted-foreground border-border/60" },
};

const MAPPING_STYLE: Record<string, { label: string; bg: string; badge: string }> = {
  mapped: {
    label: "Mapped",
    bg: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    badge: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400 bg-emerald-500/5",
  },
  unmatched: {
    label: "Unmatched",
    bg: "bg-foreground/[0.05] text-foreground border-border/60",
    badge: "border-border/60 text-muted-foreground bg-foreground/[0.02]",
  },
  conflict: {
    label: "Conflict",
    bg: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
    badge: "border-red-500/40 text-red-600 dark:text-red-400 bg-red-500/5",
  },
};

export default function Amber() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { activeDealer, me } = useAuthz();
  const isGm =
    !!activeDealer?.isGeneralManager ||
    activeDealer?.roleName === "General Manager" ||
    !!me?.isSuperAdmin;

  const { data: settings, isLoading } = useGetAmberSettings();
  const { data: devices } = useListAmberDevices();
  const { data: fleet } = useListAmberFleetState();
  const { data: events } = useListAmberEvents();
  const { data: vehicles } = useListVehicles();

  const [apiBaseUrl, setApiBaseUrl] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [newDeviceId, setNewDeviceId] = useState("");
  const [newDeviceVin, setNewDeviceVin] = useState("");
  const [mapTarget, setMapTarget] = useState<number | null>(null);
  const [mapVehicleId, setMapVehicleId] = useState<string>("");
  const [confirmVin, setConfirmVin] = useState("");

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: getGetAmberSettingsQueryKey() });
    void qc.invalidateQueries({ queryKey: getListAmberDevicesQueryKey() });
    void qc.invalidateQueries({ queryKey: getListAmberFleetStateQueryKey() });
    void qc.invalidateQueries({ queryKey: getListAmberEventsQueryKey() });
  };

  const update = useUpdateAmberSettings({
    mutation: {
      onSuccess: () => {
        toast({ title: "Amber settings saved" });
        setApiKey("");
        invalidate();
      },
      onError: (err) =>
        toast({
          title: "Save failed",
          description: err instanceof Error ? err.message : undefined,
          variant: "destructive",
        }),
    },
  });
  const test = useTestAmberConnection({
    mutation: {
      onSuccess: (r) => {
        toast({
          title:
            r.status === "connected"
              ? "Connection OK"
              : r.status === "pending_contract"
                ? "Awaiting Amber API documentation"
                : "Connection test failed",
          description: r.detail,
          variant: r.status === "error" ? "destructive" : undefined,
        });
        invalidate();
      },
    },
  });
  const rotate = useRotateAmberWebhookSecret({
    mutation: {
      onSuccess: () => {
        toast({ title: "Webhook secret rotated" });
        invalidate();
      },
    },
  });
  const register = useRegisterAmberDevice({
    mutation: {
      onSuccess: () => {
        toast({ title: "Device registered" });
        setNewDeviceId("");
        setNewDeviceVin("");
        invalidate();
      },
      onError: (err) =>
        toast({
          title: "Could not register device",
          description: err instanceof Error ? err.message : undefined,
          variant: "destructive",
        }),
    },
  });
  const mapDevice = useMapAmberDevice({
    mutation: {
      onSuccess: () => {
        toast({ title: "Device mapped to vehicle" });
        setMapTarget(null);
        setMapVehicleId("");
        setConfirmVin("");
        invalidate();
      },
      onError: (err) =>
        toast({
          title: "Mapping failed",
          description: err instanceof Error ? err.message : undefined,
          variant: "destructive",
        }),
    },
  });
  const unmap = useUnmapAmberDevice({
    mutation: { onSuccess: invalidate },
  });

  if (isLoading) {
    return (
      <Page className="flex min-h-[100dvh] items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-[10px] font-bold uppercase tracking-[0.2em]">Loading Fleet Data</p>
        </div>
      </Page>
    );
  }

  const pendingContract = settings?.contractStatus === "pending_documentation";
  const mapDeviceRow = devices?.find((d) => d.id === mapTarget) ?? null;

  const sortedDevices = [...(devices ?? [])].sort((a, b) => {
    const score = (status: string) => (status === "conflict" ? 0 : status === "unmatched" ? 1 : 2);
    return score(a.mappingStatus) - score(b.mappingStatus);
  });

  return (
    <Page>
      <PageHero
        icon={Radio}
        eyebrow="Operations"
        title="Amber Connect"
        subtitle="Vehicle telematics — device mapping, fleet state and connection health"
      />

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 lg:gap-8 mt-2" data-testid="amber-page">
        {/* Main Column: Fleet & Devices */}
        <div className="xl:col-span-2 space-y-8">
          {/* Fleet Telemetry */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-widest text-foreground flex items-center gap-2">
                <Activity className="h-4 w-4 text-primary" />
                Real-Time Telemetry
              </h2>
            </div>

            {(fleet ?? []).length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 rounded-3xl border border-dashed border-border/60 text-muted-foreground">
                <Activity className="h-8 w-8 mb-4 opacity-20" />
                <p className="text-sm font-medium text-foreground">No telemetry received</p>
                <p className="text-xs opacity-70 mt-1 max-w-sm text-center">
                  Live fleet data will stream here automatically once devices are registered and syncing.
                </p>
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 gap-4">
                {(fleet ?? []).map((s, i) => {
                  const style = FRESHNESS_STYLE[s.freshness] ?? FRESHNESS_STYLE.never;
                  return (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.05 }}
                      key={s.id}
                      data-testid={`row-amber-state-${s.deviceId}`}
                      className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-card p-4 hover:border-foreground/20 transition-colors shadow-sm"
                    >
                      <div className="flex items-start justify-between">
                        <div className="min-w-0 pr-3">
                          <div className="font-semibold text-foreground text-sm flex items-center gap-2 truncate">
                            <Car className="h-4 w-4 text-primary shrink-0" />
                            <span className="truncate">{s.vehicleLabel ?? "Unmapped device"}</span>
                          </div>
                          <div className="text-xs text-muted-foreground font-mono mt-1">
                            {s.deviceId}
                          </div>
                        </div>
                        <div className={cn("flex items-center gap-1.5 px-2 py-1 rounded-full border text-[9px] font-bold uppercase tracking-widest shrink-0", style.bg)}>
                          <span className={cn("h-1.5 w-1.5 rounded-full", style.dot)} />
                          {s.freshness}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-x-4 gap-y-3 mt-3 pt-3 border-t border-border/40">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">Odometer</span>
                          <span className="text-xs font-medium text-foreground">{s.odometerKm != null ? `${Math.round(s.odometerKm).toLocaleString()} km` : "—"}</span>
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">Ignition</span>
                          <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
                            {s.ignitionOn == null ? "—" : s.ignitionOn ? (
                              <><Power className="h-3 w-3 text-emerald-500" /> On</>
                            ) : (
                              <><Power className="h-3 w-3 text-muted-foreground opacity-50" /> Off</>
                            )}
                          </span>
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">Location</span>
                          <span className="text-xs text-foreground font-mono truncate">
                            {s.locationRestricted ? "Restricted" : s.latitude != null && s.longitude != null ? `${s.latitude.toFixed(5)}, ${s.longitude.toFixed(5)}` : "—"}
                          </span>
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">Health</span>
                          <span className="text-xs text-foreground capitalize">
                            {s.deviceHealth ?? "—"}
                          </span>
                        </div>
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-1 flex items-center gap-1.5">
                        <Clock className="h-3 w-3 opacity-60" />
                        Last event: {s.lastEventAt ? formatGuyanaDateTime(s.lastEventAt) : "never"}
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Device Directory */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-widest text-foreground flex items-center gap-2">
                <Cpu className="h-4 w-4 text-primary" />
                Fleet Devices
              </h2>
            </div>

            <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3 p-5 rounded-2xl border border-border/60 bg-card">
              <div className="flex-1 w-full space-y-2">
                <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Register Device Identity</label>
                <div className="flex flex-col sm:flex-row gap-3">
                  <Input
                    className="bg-background font-mono text-sm w-full sm:w-48"
                    value={newDeviceId}
                    onChange={(e) => setNewDeviceId(e.target.value)}
                    placeholder="Device ID / IMEI"
                    data-testid="input-amber-device-id"
                  />
                  <Input
                    className="bg-background text-sm w-full sm:w-56"
                    value={newDeviceVin}
                    onChange={(e) => setNewDeviceVin(e.target.value)}
                    placeholder="Reported VIN (optional)"
                    data-testid="input-amber-device-vin"
                  />
                  <Button
                    className="w-full sm:w-auto"
                    disabled={!newDeviceId.trim() || register.isPending}
                    onClick={() =>
                      register.mutate({
                        data: {
                          deviceId: newDeviceId.trim(),
                          ...(newDeviceVin.trim() ? { reportedVin: newDeviceVin.trim() } : {}),
                        },
                      })
                    }
                    data-testid="button-amber-register-device"
                  >
                    {register.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
                    Register
                  </Button>
                </div>
              </div>
            </div>

            <div className="space-y-3 pt-2">
              {sortedDevices.map((d, i) => {
                const style = MAPPING_STYLE[d.mappingStatus] ?? MAPPING_STYLE.unmatched;
                return (
                  <motion.div
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.04 }}
                    key={d.id}
                    data-testid={`row-amber-device-${d.deviceId}`}
                    className={cn(
                      "flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-2xl border transition-colors shadow-sm",
                      d.mappingStatus === "conflict" ? "border-red-500/30 bg-red-500/5 hover:border-red-500/40" :
                        d.mappingStatus === "unmatched" ? "border-gold/30 bg-gold/5 hover:border-gold/40" :
                          "border-border/60 bg-card hover:border-foreground/20"
                    )}
                  >
                    <div className="flex items-center gap-4 min-w-0">
                      <div className={cn("h-10 w-10 rounded-full flex items-center justify-center shrink-0 border", style.bg)}>
                        {d.mappingStatus === "conflict" ? <AlertTriangle className="h-4 w-4" /> : <MapPin className="h-4 w-4" />}
                      </div>
                      <div className="min-w-0">
                        <div className="font-mono text-sm font-semibold text-foreground flex items-center gap-2">
                          {d.deviceId}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1 truncate">
                          {d.vehicleLabel
                            ? `${d.vehicleLabel} · ${d.vehicleVin ?? ""}`
                            : d.reportedVin
                              ? `Reported VIN ${d.reportedVin}`
                              : "No vehicle assigned"}
                          {d.conflictReason ? <span className="text-red-500 font-medium ml-1.5">— {d.conflictReason}</span> : ""}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 shrink-0">
                      <Badge variant="outline" className={cn("text-[9px] uppercase tracking-widest font-bold", style.badge)}>
                        {style.label}
                      </Badge>
                      {d.mappingStatus === "mapped" ? (
                        <Button size="sm" variant="ghost" className="h-8 text-muted-foreground hover:text-red-500 hover:bg-red-500/10" onClick={() => unmap.mutate({ id: d.id })} data-testid={`button-amber-unmap-${d.deviceId}`}>
                          <Unlink className="mr-1.5 h-3.5 w-3.5" /> Unmap
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" className="h-8 border-gold text-gold hover:bg-gold hover:text-gold-foreground" onClick={() => {
                          setMapTarget(d.id);
                          setConfirmVin("");
                          setMapVehicleId("");
                        }} data-testid={`button-amber-map-${d.deviceId}`}>
                          <Link2 className="mr-1.5 h-3.5 w-3.5" /> Map Vehicle
                        </Button>
                      )}
                    </div>
                  </motion.div>
                );
              })}
              {sortedDevices.length === 0 && (
                <div className="py-12 text-center flex flex-col items-center justify-center border border-dashed border-border/60 rounded-3xl text-muted-foreground">
                  <MapPin className="h-8 w-8 mb-3 opacity-20" />
                  <p className="text-sm font-medium text-foreground">No devices tracked</p>
                  <p className="text-xs opacity-70 mt-1 max-w-xs">
                    Register device identities manually or they will appear automatically as events arrive.
                  </p>
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Side Column: Config & Events */}
        <div className="space-y-6">
          {/* Connection */}
          <section className="rounded-3xl border border-border/60 bg-card overflow-hidden shadow-sm">
            <div className="bg-foreground/[0.02] p-5 border-b border-border/60 flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-widest text-foreground flex items-center gap-2">
                <Cable className="h-4 w-4 text-primary" />
                Provider Link
              </h2>
              <Badge
                variant="outline"
                className={cn("text-[9px] font-bold uppercase tracking-widest", settings?.enabled ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/5" : "border-border/60 text-muted-foreground")}
                data-testid="badge-amber-enabled"
              >
                {settings?.enabled ? "Active" : "Disabled"}
              </Badge>
            </div>
            <div className="p-5 space-y-6">
              {pendingContract && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 flex gap-3 text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <div className="text-xs leading-relaxed font-medium">
                    Amber Connect API documentation is pending. Configurations and device mappings can be staged, but live provider calls stay off.
                  </div>
                </div>
              )}

              {isGm ? (
                <div className="space-y-5">
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">API Base URL</label>
                    <Input
                      className="bg-background text-sm"
                      value={apiBaseUrl ?? settings?.apiBaseUrl ?? ""}
                      onChange={(e) => setApiBaseUrl(e.target.value)}
                      placeholder="https://…"
                      data-testid="input-amber-base-url"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                      API Key {settings?.hasApiKey && <span className="opacity-70 normal-case tracking-normal font-normal">(stored: {settings.apiKeyHint}…)</span>}
                    </label>
                    <Input
                      className="bg-background text-sm"
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={settings?.hasApiKey ? "Leave blank to keep current" : "Amber API key"}
                      data-testid="input-amber-api-key"
                    />
                  </div>

                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      size="sm"
                      className="flex-1"
                      disabled={update.isPending}
                      onClick={() =>
                        update.mutate({
                          data: {
                            ...(apiBaseUrl !== null ? { apiBaseUrl } : {}),
                            ...(apiKey ? { apiKey } : {}),
                          },
                        })
                      }
                      data-testid="button-amber-save"
                    >
                      {update.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Settings2 className="mr-1.5 h-3.5 w-3.5" />}
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      disabled={!settings?.configured || test.isPending}
                      onClick={() => test.mutate()}
                      data-testid="button-amber-test"
                    >
                      {test.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                      Test
                    </Button>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full border-border hover:bg-foreground/5 hover:text-foreground"
                    disabled={!settings?.configured || update.isPending}
                    onClick={() =>
                      update.mutate({ data: { enabled: !settings?.enabled } })
                    }
                    data-testid="button-amber-toggle"
                  >
                    {settings?.enabled ? "Disable Integration" : "Enable Integration"}
                  </Button>

                  {settings?.webhookSecret && (
                    <div className="mt-4 p-3.5 rounded-xl bg-foreground/[0.02] border border-border/60 space-y-2.5">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                        <KeyRound className="h-3 w-3" /> Inbound Webhook
                      </div>
                      <div className="text-xs font-mono text-foreground break-all leading-relaxed bg-background p-2 rounded border border-border/50">
                        POST {settings.webhookPath}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        HMAC-SHA256 signature header <code className="text-foreground bg-foreground/[0.05] px-1 py-0.5 rounded font-mono">x-amber-signature</code>
                      </div>
                      <div className="flex items-center justify-between gap-2 pt-2 border-t border-border/40">
                        <span className="font-mono text-xs text-muted-foreground">
                          {settings.webhookSecret.slice(0, 6)}••••••••
                        </span>
                        <div className="flex items-center gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-muted-foreground hover:text-foreground"
                            onClick={() => {
                              void navigator.clipboard.writeText(settings.webhookSecret ?? "");
                              toast({ title: "Webhook secret copied" });
                            }}
                            data-testid="button-amber-copy-secret"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-amber-600 hover:text-amber-700 hover:bg-amber-500/10 dark:text-amber-400 dark:hover:text-amber-300"
                            disabled={rotate.isPending}
                            onClick={() => rotate.mutate()}
                            data-testid="button-amber-rotate-secret"
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center p-6 text-center border border-dashed border-border/60 rounded-xl bg-foreground/[0.01]">
                  <ShieldCheck className="h-6 w-6 text-muted-foreground/40 mb-3" />
                  <p className="text-xs text-muted-foreground font-medium">
                    Integration configuration is restricted to General Managers.
                  </p>
                </div>
              )}

              <div className="pt-4 border-t border-border/40 grid grid-cols-2 gap-4 text-[10px] text-muted-foreground">
                <div>
                  <div className="font-bold uppercase tracking-widest mb-1.5 opacity-70">Last Test</div>
                  {settings?.lastStatus ? (
                    <span className="flex items-center gap-1.5 font-medium text-foreground">
                      {settings.lastStatus === "connected" ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                      ) : settings.lastStatus === "error" ? (
                        <XCircle className="h-3.5 w-3.5 text-red-500" />
                      ) : (
                        <Clock className="h-3.5 w-3.5 text-amber-500" />
                      )}
                      <span className="capitalize">{settings.lastStatus}</span>
                    </span>
                  ) : "Never"}
                  {settings?.lastCheckedAt && <div className="mt-1 opacity-70 font-mono text-[9px]">{formatGuyanaDateTime(settings.lastCheckedAt)}</div>}
                </div>
                <div>
                  <div className="font-bold uppercase tracking-widest mb-1.5 opacity-70">Last Sync</div>
                  <span className="font-medium text-foreground capitalize">{settings?.lastSyncStatus || "Never"}</span>
                  {settings?.lastSyncAt && <div className="mt-1 opacity-70 font-mono text-[9px]">{formatGuyanaDateTime(settings.lastSyncAt)}</div>}
                </div>
              </div>
            </div>
          </section>

          {/* Events */}
          <section className="rounded-3xl border border-border/60 bg-card overflow-hidden shadow-sm flex flex-col h-[480px]">
            <div className="bg-foreground/[0.02] p-5 border-b border-border/60 shrink-0">
              <h2 className="text-sm font-bold uppercase tracking-widest text-foreground flex items-center gap-2">
                <Database className="h-4 w-4 text-primary" />
                System Events
              </h2>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-3 relative no-scrollbar">
              {(events ?? []).length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                  <Database className="h-6 w-6 mb-3 opacity-20" />
                  <div className="text-xs font-medium">No events ingested</div>
                </div>
              )}
              {(events ?? []).map(e => (
                <div key={e.id} className="text-xs p-3 rounded-xl border border-border/50 bg-background/50 hover:bg-background transition-colors" data-testid={`row-amber-event-${e.externalId}`}>
                  <div className="flex items-start justify-between mb-2">
                    <span className="font-mono text-[10px] text-muted-foreground">{e.deviceId}</span>
                    <span className={cn(
                      "text-[8px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-sm shrink-0 ml-2 border",
                      e.status === "processed" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20" :
                        e.status === "error" ? "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20" :
                          "bg-foreground/5 text-muted-foreground border-border/50"
                    )}>
                      {e.status}
                    </span>
                  </div>
                  <div className="text-foreground font-medium leading-tight pr-2">{e.type}</div>
                  <div className="text-[9px] text-muted-foreground font-mono mt-1.5 opacity-70">
                    {formatGuyanaDateTime(e.occurredAt)}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      {/* Map dialog with explicit VIN confirmation */}
      <Dialog open={mapTarget != null} onOpenChange={(o) => !o && setMapTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-xl font-light tracking-tight">
              Map Device <span className="font-mono font-medium text-primary">{mapDeviceRow?.deviceId}</span>
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-5 py-2">
            <div className="space-y-2">
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Select Target Vehicle
              </label>
              <Select value={mapVehicleId} onValueChange={setMapVehicleId}>
                <SelectTrigger data-testid="select-amber-map-vehicle" className="bg-background">
                  <SelectValue placeholder="Select vehicle..." />
                </SelectTrigger>
                <SelectContent>
                  {(vehicles ?? []).map((v) => (
                    <SelectItem key={v.id} value={String(v.id)}>
                      {v.year} {v.make} {v.model} — <span className="font-mono text-muted-foreground">{v.vin ?? "no VIN"}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 border-t border-border/40 pt-4">
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Type the vehicle's VIN to confirm
              </label>
              <Input
                className="bg-background font-mono text-sm uppercase placeholder:normal-case placeholder:text-muted-foreground/60 placeholder:font-sans"
                value={confirmVin}
                onChange={(e) => setConfirmVin(e.target.value.toUpperCase())}
                placeholder="VIN confirmation..."
                data-testid="input-amber-confirm-vin"
              />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="ghost" onClick={() => setMapTarget(null)}>
              Cancel
            </Button>
            <Button
              className="bg-gold hover:bg-gold/90 text-gold-foreground border-transparent shadow-sm"
              disabled={!mapVehicleId || !confirmVin.trim() || mapDevice.isPending}
              onClick={() =>
                mapTarget != null &&
                mapDevice.mutate({
                  id: mapTarget,
                  data: {
                    vehicleId: Number(mapVehicleId),
                    confirmVin: confirmVin.trim(),
                  },
                })
              }
              data-testid="button-amber-confirm-map"
            >
              {mapDevice.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Confirm Mapping
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
