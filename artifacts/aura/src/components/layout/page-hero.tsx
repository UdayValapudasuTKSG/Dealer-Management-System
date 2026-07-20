import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * Cinematic full-width video band used at the top of module pages.
 * Mirrors the dashboard briefing band: dark video + black scrims so white
 * text stays legible in BOTH themes. Render it OUTSIDE the <Page> gutter
 * (full bleed), with the page content below.
 */
export function PageHero({
  video,
  eyebrow,
  icon: Icon,
  title,
  accent,
  subtitle,
  action,
  className,
}: {
  /** filename inside public/videos, e.g. "service_bay.mp4" */
  video: string;
  eyebrow?: string;
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  accent?: string;
  subtitle?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative h-[110px] md:h-[128px] w-full bg-black overflow-hidden",
        className,
      )}
    >
      <div className="absolute inset-0 z-0">
        <video
          autoPlay
          muted
          loop
          playsInline
          className="w-full h-full object-cover opacity-60 mix-blend-screen"
        >
          <source
            src={`${import.meta.env.BASE_URL}videos/${video}`}
            type="video/mp4"
          />
        </video>
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/45 to-black/25" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/70 via-black/30 to-transparent" />
      </div>

      <div className="relative z-10 h-full px-5 md:px-8 flex items-center justify-between gap-4">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="min-w-0"
        >
          {eyebrow && (
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-white/70 mb-1">
              {Icon && <Icon className="w-3.5 h-3.5" />}
              {eyebrow}
            </div>
          )}
          <h1 className="text-xl md:text-2xl font-light tracking-tight text-white leading-tight drop-shadow-md">
            {title}
            {accent && <span className="font-semibold"> {accent}</span>}
          </h1>
          {subtitle && (
            <p className="text-white/70 text-[13px] mt-0.5 font-light drop-shadow truncate">
              {subtitle}
            </p>
          )}
        </motion.div>
        {action && <div className="shrink-0 relative z-10">{action}</div>}
      </div>
    </div>
  );
}
