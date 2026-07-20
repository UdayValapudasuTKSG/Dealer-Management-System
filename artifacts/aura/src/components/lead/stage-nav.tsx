import { motion } from "framer-motion";
import { Check, Lock, Compass } from "lucide-react";
import { cn } from "@/lib/utils";

export type StageCheckItem = { label: string; done: boolean };
export type StageNavStage = {
  key: string;
  label: string;
  caption: string;
  checklist: StageCheckItem[];
};

/**
 * Horizontal top navigation pane for the lead journey.
 * The 8 pipeline phases run across the top as a stepper; the current stage's
 * success-guidance checklist expands in a panel beneath it.
 */
export function StageNav({
  stages,
  currentIndex,
}: {
  stages: StageNavStage[];
  currentIndex: number;
}) {
  const current = stages[currentIndex];
  const pct =
    stages.length > 1 ? (currentIndex / (stages.length - 1)) * 100 : 0;

  return (
    <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-5 overflow-hidden relative">
      <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground mb-5">
        Journey
      </div>

      {/* Horizontal stepper */}
      <div className="relative overflow-x-auto pb-1 -mx-1 px-1">
        <ol className="relative flex items-start min-w-[640px]">
          {/* Rail */}
          <div className="absolute top-[13px] left-[calc(100%/16)] right-[calc(100%/16)] h-px bg-white/10" />
          <motion.div
            className="absolute top-[13px] left-[calc(100%/16)] h-px bg-primary origin-left"
            style={{ maxWidth: "calc(100% - 100%/8)" }}
            initial={{ width: 0 }}
            animate={{ width: `calc((100% - 100%/8) * ${pct / 100})` }}
            transition={{ duration: 0.9, ease: "easeOut" }}
          />
          {stages.map((s, i) => {
            const state =
              i < currentIndex
                ? "done"
                : i === currentIndex
                  ? "current"
                  : "next";
            return (
              <li
                key={s.key}
                className="relative flex-1 flex flex-col items-center text-center px-1"
              >
                <span
                  className={cn(
                    "relative z-10 w-[27px] h-[27px] rounded-full flex items-center justify-center ring-1 transition-colors bg-[#101010]",
                    state === "done" &&
                      "bg-primary/15 text-primary ring-primary/40",
                    state === "current" &&
                      "bg-primary text-primary-foreground ring-primary shadow-[0_0_14px_rgba(229,9,20,0.5)]",
                    state === "next" &&
                      "bg-foreground/[0.04] text-muted-foreground/50 ring-white/10",
                  )}
                >
                  {state === "done" ? (
                    <Check className="w-3.5 h-3.5" />
                  ) : state === "next" ? (
                    <Lock className="w-3 h-3" />
                  ) : (
                    <motion.span
                      className="w-2 h-2 rounded-full bg-primary-foreground"
                      animate={{ scale: [1, 1.35, 1], opacity: [1, 0.7, 1] }}
                      transition={{ duration: 1.8, repeat: Infinity }}
                    />
                  )}
                </span>
                <div
                  className={cn(
                    "mt-2 text-[11px] sm:text-xs font-semibold tracking-tight leading-tight",
                    state === "current"
                      ? "text-foreground"
                      : state === "done"
                        ? "text-foreground/70"
                        : "text-muted-foreground/60",
                  )}
                >
                  {s.label}
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      {/* Success guidance for the current stage */}
      {current && (
        <motion.div
          key={current.key}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="mt-5 rounded-xl border border-primary/20 bg-primary/[0.05] p-4"
        >
          <div className="flex items-center gap-2 mb-1.5">
            <span className="w-6 h-6 rounded-full bg-primary/15 text-primary flex items-center justify-center shrink-0">
              <Compass className="w-3 h-3" />
            </span>
            <span className="text-xs font-bold uppercase tracking-widest text-primary">
              {current.label} — success guidance
            </span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed mb-3">
            {current.caption}
          </p>
          {current.checklist.length > 0 && (
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1.5">
              {current.checklist.map((c, ci) => (
                <motion.li
                  key={c.label}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.15 + ci * 0.07 }}
                  className="flex items-start gap-2 text-xs"
                >
                  <span
                    className={cn(
                      "mt-[1px] w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0 ring-1",
                      c.done
                        ? "bg-emerald-500/20 text-emerald-400 ring-emerald-500/40"
                        : "bg-foreground/[0.05] text-muted-foreground/40 ring-white/10",
                    )}
                  >
                    {c.done && <Check className="w-2.5 h-2.5" />}
                  </span>
                  <span
                    className={cn(
                      c.done
                        ? "text-foreground/60 line-through decoration-foreground/30"
                        : "text-foreground/85",
                    )}
                  >
                    {c.label}
                  </span>
                </motion.li>
              ))}
            </ul>
          )}
        </motion.div>
      )}
    </div>
  );
}
