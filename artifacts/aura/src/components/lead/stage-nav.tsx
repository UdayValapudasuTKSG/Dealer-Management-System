import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import {
  Check,
  Compass,
  UserPlus,
  PhoneCall,
  MessagesSquare,
  CalendarCheck,
  KeySquare,
  CreditCard,
  ClipboardList,
  Flag,
  CircleDot,
  type LucideIcon,
} from "lucide-react";
import { CarProgress } from "@/components/car-progress";

export type StageCheckItem = { label: string; done: boolean };
export type StageNavStage = {
  key: string;
  label: string;
  caption: string;
  checklist: StageCheckItem[];
};

const STAGE_ICON: Record<string, LucideIcon> = {
  new_lead: UserPlus,
  contacted: PhoneCall,
  engaged: MessagesSquare,
  pre_book: CalendarCheck,
  vehicle_allocated: KeySquare,
  payment: CreditCard,
  pre_delivery: ClipboardList,
  delivered: Flag,
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

  return (
    <div className="space-y-4">
      {/* Journey — order-tracking rail with the car at the current stage */}
      <CarProgress
        stages={stages.map((s) => ({
          key: s.key,
          label: s.label,
          icon: STAGE_ICON[s.key] ?? CircleDot,
        }))}
        activeIndex={currentIndex}
      />

      {/* Success guidance for the current stage */}
      {current && (
        <motion.div
          key={current.key}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="rounded-xl border border-primary/20 bg-primary/[0.05] p-4"
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
