import type { ReactNode } from "react";
import { ShieldAlert, Lock } from "lucide-react";

/** Server error → human message, with explicit handling of revision conflicts. */
export function apiErrorMessage(err: unknown): string {
  const e = err as {
    status?: number;
    message?: string;
    data?: { error?: string; message?: string; code?: string };
  };
  const code = e?.data?.code ?? e?.data?.error ?? "";
  if (e?.status === 409 || /revision|conflict|stale/i.test(code)) {
    return "Someone else saved a newer revision. Your view has been refreshed — review the latest values and re-apply your change.";
  }
  return e?.data?.message ?? e?.data?.error ?? e?.message ?? "Request failed";
}

export const STAGE_ORDER = [
  "VS-01", "VS-02", "VS-03", "VS-04", "VS-05",
  "VS-06", "VS-07", "VS-08", "VS-09", "VS-10",
] as const;

export const SOURCE_STAGES = ["VS-03", "VS-05", "VS-09", "VS-10"];
export const AMOUNT_STAGES = ["VS-03", "VS-05", "VS-08", "VS-09", "VS-10"];

export const fieldCls =
  "h-9 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 text-sm outline-none focus:border-primary/60 disabled:opacity-50";

/** Entry state chip. Never says "posted"/"completed" for GL stages. */
export function EntryStateChip({ state, posts }: { state: string; posts: boolean }) {
  const map: Record<string, { label: string; cls: string }> = {
    draft: { label: "Draft workpaper", cls: "bg-amber-500/12 text-amber-400 border-amber-500/30" },
    blocked: { label: "Draft · blocked", cls: "bg-red-500/12 text-red-400 border-red-500/30" },
    reviewed: {
      label: posts ? "Reviewed · not posted" : "Reviewed",
      cls: "bg-emerald-500/12 text-emerald-400 border-emerald-500/30",
    },
    complete: {
      label: posts ? "Reviewed · not posted" : "Confirmed (no GL)",
      cls: "bg-sky-500/12 text-sky-400 border-sky-500/30",
    },
  };
  const m = map[state] ?? { label: state.replace(/_/g, " "), cls: "bg-white/5 text-muted-foreground border-white/10" };
  return (
    <span data-testid={`status-entry-${state}`} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest ${m.cls}`}>
      {m.label}
    </span>
  );
}

/** The non-negotiable release banner shown on both pages. */
export function PreparationBanner({ children }: { children?: ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-primary/25 bg-[repeating-linear-gradient(135deg,hsl(var(--primary)/0.06)_0_10px,transparent_10px_20px)] p-4">
      <div className="flex gap-3">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="space-y-1 text-sm">
          <p className="font-semibold tracking-tight">Preparation and review mode — nothing posts to the books.</p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Workpapers here document funding and balanced GL lines only. Saving never creates invoices,
            payments or VIN holds. Operational requests use separate Finance approvals.
            New sales at all dealerships are covered; advance VAT policy remains pending.
          </p>
          {children}
        </div>
      </div>
    </div>
  );
}

export function Unavailable({ title, body }: { title: string; body: string }) {
  return (
    <div className="glass-panel rounded-2xl p-10 text-center space-y-3" data-testid="state-unavailable">
      <ShieldAlert className="mx-auto h-8 w-8 text-amber-400" />
      <h2 className="font-semibold tracking-tight">{title}</h2>
      <p className="mx-auto max-w-md text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
