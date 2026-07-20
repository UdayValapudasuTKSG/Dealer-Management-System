import { motion } from "framer-motion";
import { Check, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

export type StageCheckItem = { label: string; done: boolean };
export type StageNavStage = {
  key: string;
  label: string;
  caption: string;
  checklist: StageCheckItem[];
};

/**
 * Vertical sub-process navigation pane for the lead journey.
 * Renders the 8 pipeline phases as a stepper: completed stages collapse to a
 * check, the current stage expands its Guidance-for-Success checklist, and
 * future stages show locked.
 */
export function StageNav({
  stages,
  currentIndex,
}: {
  stages: StageNavStage[];
  currentIndex: number;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-4 overflow-hidden relative">
      <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground mb-4 px-1">
        Journey
      </div>
      <ol className="relative">
        {/* Rail line */}
        <div className="absolute left-[13px] top-2 bottom-2 w-px bg-white/10" />
        <motion.div
          className="absolute left-[13px] top-2 w-px bg-primary origin-top"
          initial={{ height: 0 }}
          animate={{
            height: `${Math.min(100, (currentIndex / Math.max(1, stages.length - 1)) * 100)}%`,
          }}
          transition={{ duration: 0.9, ease: "easeOut" }}
        />
        {stages.map((s, i) => {
          const state =
            i < currentIndex ? "done" : i === currentIndex ? "current" : "next";
          return (
            <li key={s.key} className="relative pl-9 pb-4 last:pb-0">
              {/* Node */}
              <span
                className={cn(
                  "absolute left-0 top-0 w-[27px] h-[27px] rounded-full flex items-center justify-center ring-1 transition-colors",
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
                  "text-sm font-semibold tracking-tight leading-[27px]",
                  state === "current"
                    ? "text-foreground"
                    : state === "done"
                      ? "text-foreground/70"
                      : "text-muted-foreground/60",
                )}
              >
                {s.label}
              </div>

              {state === "current" && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  transition={{ duration: 0.35 }}
                  className="overflow-hidden"
                >
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {s.caption}
                  </p>
                  {s.checklist.length > 0 && (
                    <ul className="mt-2.5 space-y-1.5 rounded-xl border border-primary/20 bg-primary/[0.05] p-3">
                      {s.checklist.map((c, ci) => (
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
            </li>
          );
        })}
      </ol>
    </div>
  );
}
