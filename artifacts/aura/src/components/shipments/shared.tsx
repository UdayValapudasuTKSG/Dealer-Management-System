import { Link, useLocation } from "wouter";
import type { ShipmentSpec } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

export function errMsg(e: unknown): string {
  const d = (e as { data?: { error?: string } } | null)?.data;
  if (d && typeof d.error === "string") return d.error;
  return e instanceof Error ? e.message : "Something went wrong";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function monthLabel(m: string | null | undefined): string {
  if (!m) return "-";
  const [y, mm] = m.split("-");
  return `${MONTHS[Number(mm) - 1] ?? mm} ${y}`;
}

export function specLine(s: ShipmentSpec): string {
  return `${s.year} ${s.make} ${s.model} ${s.variant}`;
}

export function SpecCell({ spec, className }: { spec: ShipmentSpec; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="font-medium text-foreground truncate">{specLine(spec)}</div>
      <div className="text-xs text-muted-foreground truncate">
        Ext <span className="text-foreground/80">{spec.exteriorColor}</span>
        <span className="mx-1.5 opacity-40">/</span>
        Int <span className="text-foreground/80">{spec.interiorColor}</span>
      </div>
    </div>
  );
}

const TONES: Record<string, string> = {
  open: "bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-sky-500/20",
  in_transit: "bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-500/25",
  arrived: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/20",
  closed: "bg-muted text-muted-foreground ring-border",
  cancelled: "bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-rose-500/20",
  draft: "bg-muted text-muted-foreground ring-border",
  approved: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/20",
  retired: "bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-rose-500/20",
  active: "bg-primary/10 text-primary ring-primary/20",
  fulfilled: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/20",
  released: "bg-muted text-muted-foreground ring-border",
  reassigned: "bg-muted text-muted-foreground ring-border",
  pending: "bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-500/25",
  confirmed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/20",
  superseded: "bg-muted text-muted-foreground ring-border",
  rejected: "bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-rose-500/20",
  withheld: "bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-500/25",
  suppressed: "bg-muted text-muted-foreground ring-border",
  queued: "bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-sky-500/20",
  sent: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/20",
  failed: "bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-rose-500/20",
  unmatched: "bg-muted text-muted-foreground ring-border",
  proposed: "bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-500/25",
  lapsed: "bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-rose-500/20",
};

export function Pill({ status, label }: { status: string; label?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset whitespace-nowrap",
        TONES[status] ?? "bg-muted text-muted-foreground ring-border",
      )}
    >
      {label ?? status.replace(/_/g, " ")}
    </span>
  );
}

const TABS = [
  { href: "/shipments", label: "Shipments" },
  { href: "/shipments/tracking", label: "Customer tracking" },
  { href: "/shipments/catalogue", label: "Spec catalogue" },
  { href: "/shipments/exceptions", label: "Exceptions" },
];

export function ShipmentsNav() {
  const [loc] = useLocation();
  return (
    <nav className="flex gap-1 border-b border-border mb-6 overflow-x-auto" data-testid="shipments-nav">
      {TABS.map((t) => {
        const active = t.href === "/shipments" ? loc === "/shipments" : loc.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              "px-3 py-2 text-sm -mb-px border-b-2 whitespace-nowrap transition-colors",
              active ? "border-primary text-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function EmptyBlock({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/40 px-6 py-10 text-center">
      <div className="text-base font-semibold text-foreground">{title}</div>
      <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 px-5 py-4 text-sm flex items-center justify-between gap-4">
      <span className="text-rose-700 dark:text-rose-300">{errMsg(error)}</span>
      <button type="button" onClick={onRetry} className="text-sm font-medium underline underline-offset-4">
        Retry
      </button>
    </div>
  );
}

export function RowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-12 rounded-lg bg-muted/60 animate-pulse" />
      ))}
    </div>
  );
}
