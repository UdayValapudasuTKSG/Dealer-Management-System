import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * Compact page header used at the top of module pages (2026-07 light
 * redesign — the old full-bleed black cinematic band is gone). Renders a
 * slim title row that sits on the sky-blue canvas: eyebrow + icon chip,
 * title, subtitle, and an optional action slot on the right.
 *
 * The `video` prop is accepted for backwards compatibility but IGNORED —
 * hero videos live only on the landing page.
 */
export function PageHero({
  eyebrow,
  icon: Icon,
  title,
  accent,
  subtitle,
  action,
  className,
}: {
  /** @deprecated ignored — module pages no longer render video bands */
  video?: string;
  eyebrow?: string;
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  accent?: string;
  subtitle?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("w-full px-5 md:px-8 pt-1 pb-5", className)}>
      <div className="flex items-end justify-between gap-4">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="min-w-0 flex items-center gap-3.5"
        >
          {Icon && (
            <span className="hidden sm:flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/15 text-primary">
              <Icon className="w-5 h-5" />
            </span>
          )}
          <div className="min-w-0">
            {eyebrow && (
              <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-primary/70 mb-0.5">
                {eyebrow}
              </div>
            )}
            <h1 className="text-xl md:text-2xl font-light tracking-tight text-foreground leading-tight">
              {title}
              {accent && <span className="font-semibold"> {accent}</span>}
            </h1>
            {subtitle && (
              <p className="text-muted-foreground text-[13px] mt-0.5 font-light truncate max-w-2xl">
                {subtitle}
              </p>
            )}
          </div>
        </motion.div>
        {action && <div className="shrink-0 relative z-10">{action}</div>}
      </div>
    </div>
  );
}
