import { motion } from "framer-motion";
import { Check, Car } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

export type CarProgressStage = {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Optional count badge shown under the label (pipeline view). */
  count?: number;
};

/**
 * Order-tracking-style journey rail: a horizontal track with icon
 * checkpoints, a filled progress line, and a car that drives to the
 * active stage. Stages before `activeIndex` render as completed checks.
 *
 * If `onSelect` is provided the checkpoints are clickable (pipeline
 * filter); otherwise it is a read-only journey tracker (lead detail).
 */
export function CarProgress({
  stages,
  activeIndex,
  onSelect,
  className,
}: {
  stages: CarProgressStage[];
  activeIndex: number;
  onSelect?: (key: string, index: number) => void;
  className?: string;
}) {
  const n = stages.length;
  if (n === 0) return null;
  const clamped = Math.max(0, Math.min(activeIndex, n - 1));
  // Center of each checkpoint as a % across the track.
  const centerPct = (i: number) => ((i + 0.5) / n) * 100;
  const progressPct = centerPct(clamped);

  return (
    <div
      className={cn(
        "rounded-2xl bg-card border border-border/60 shadow-sm px-2 sm:px-4 pt-8 pb-3 overflow-x-auto",
        className,
      )}
    >
      <div className="min-w-[720px]">
        {/* Track */}
        <div className="relative h-9">
          {/* base line */}
          <div
            className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-foreground/[0.08]"
            style={{ left: `${centerPct(0)}%`, right: `${100 - centerPct(n - 1)}%` }}
          />
          {/* filled line */}
          <motion.div
            className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-primary"
            initial={false}
            animate={{
              width: `${Math.max(0, progressPct - centerPct(0))}%`,
            }}
            transition={{ type: "spring", stiffness: 200, damping: 28 }}
            style={{ left: `${centerPct(0)}%` }}
          />
          {/* checkpoints */}
          {stages.map((s, i) => {
            const done = i < clamped;
            const current = i === clamped;
            return (
              <div
                key={s.key}
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2"
                style={{ left: `${centerPct(i)}%` }}
              >
                <span
                  className={cn(
                    "flex items-center justify-center rounded-full ring-4 ring-card transition-colors",
                    current
                      ? "h-7 w-7 bg-primary text-white"
                      : done
                        ? "h-6 w-6 bg-primary text-white"
                        : "h-6 w-6 bg-card border-2 border-foreground/[0.15] text-transparent",
                  )}
                >
                  {done || current ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : null}
                </span>
              </div>
            );
          })}
          {/* the car — drives along the track to the active stage */}
          <motion.div
            className="absolute -top-6 -translate-x-1/2 text-primary pointer-events-none"
            initial={false}
            animate={{ left: `${progressPct}%` }}
            transition={{ type: "spring", stiffness: 170, damping: 22 }}
          >
            <motion.span
              className="block drop-shadow-sm"
              animate={{ y: [0, -1.5, 0] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
            >
              <Car className="h-6 w-6" />
            </motion.span>
          </motion.div>
        </div>

        {/* Labels */}
        <div className="mt-3 grid" style={{ gridTemplateColumns: `repeat(${n}, minmax(0,1fr))` }}>
          {stages.map((s, i) => {
            const done = i < clamped;
            const current = i === clamped;
            const Icon = s.icon;
            const inner = (
              <>
                <Icon
                  className={cn(
                    "h-4 w-4 mb-1",
                    current ? "text-primary" : done ? "text-primary/70" : "text-muted-foreground/60",
                  )}
                />
                <span
                  className={cn(
                    "text-[11px] font-semibold leading-tight",
                    current
                      ? "text-foreground"
                      : done
                        ? "text-foreground/70"
                        : "text-muted-foreground/70",
                  )}
                >
                  {s.label}
                </span>
                {s.count != null && (
                  <span
                    className={cn(
                      "mt-1 rounded-full px-2 py-px text-[10px] font-bold tabular-nums",
                      current
                        ? "bg-primary text-white"
                        : "bg-foreground/[0.06] text-muted-foreground",
                    )}
                  >
                    {s.count}
                  </span>
                )}
              </>
            );
            return onSelect ? (
              <button
                key={s.key}
                onClick={() => onSelect(s.key, i)}
                className={cn(
                  "flex flex-col items-center text-center px-1 py-1.5 rounded-xl transition-colors",
                  current ? "" : "hover:bg-foreground/[0.04]",
                )}
              >
                {inner}
              </button>
            ) : (
              <div key={s.key} className="flex flex-col items-center text-center px-1 py-1.5">
                {inner}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
