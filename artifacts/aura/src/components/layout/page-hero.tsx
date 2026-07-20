import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * Full-width header band used at the top of module pages.
 * By default renders a futuristic static backdrop (dark gradient + grid +
 * animated aurora sweep). Pass `video` ONLY for the home / command-center
 * surfaces — module pages stay video-free by design.
 * Render it OUTSIDE the <Page> gutter (full bleed), with content below.
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
  /** OPTIONAL filename inside public/videos — home/command center only */
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
    <div
      className={cn(
        "relative h-[132px] md:h-[148px] w-full bg-black overflow-hidden",
        className,
      )}
    >
      <div className="absolute inset-0 z-0">
        {video ? (
          <>
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
          </>
        ) : (
          <>
            {/* Futuristic static backdrop */}
            <div className="absolute inset-0 bg-gradient-to-br from-[#16060a] via-black to-[#050508]" />
            {/* Perspective grid */}
            <div
              className="absolute inset-0 opacity-[0.13]"
              style={{
                backgroundImage:
                  "linear-gradient(rgba(255,255,255,0.35) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.35) 1px, transparent 1px)",
                backgroundSize: "44px 44px",
                maskImage:
                  "radial-gradient(ellipse 90% 120% at 20% 100%, black 30%, transparent 75%)",
                WebkitMaskImage:
                  "radial-gradient(ellipse 90% 120% at 20% 100%, black 30%, transparent 75%)",
              }}
            />
            {/* Aurora sweep */}
            <motion.div
              aria-hidden
              className="absolute -inset-y-1/2 w-[45%] rotate-12 bg-gradient-to-r from-transparent via-primary/[0.16] to-transparent blur-2xl"
              initial={{ x: "-60%" }}
              animate={{ x: "320%" }}
              transition={{
                duration: 9,
                repeat: Infinity,
                ease: "linear",
                repeatDelay: 2.5,
              }}
            />
            {/* Red glow anchored bottom-left behind the title */}
            <div className="absolute -bottom-24 -left-16 w-[420px] h-[220px] rounded-full bg-primary/[0.14] blur-3xl" />
            {/* Hairline accent along the bottom */}
            <div className="absolute bottom-0 inset-x-0 h-px bg-gradient-to-r from-primary/60 via-primary/15 to-transparent" />
          </>
        )}
      </div>

      <div className="relative z-10 h-full px-5 md:px-8 flex items-end justify-between gap-4 pb-5">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="min-w-0"
        >
          {eyebrow && (
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-white/60 mb-1.5">
              {Icon && <Icon className="w-3.5 h-3.5 text-primary" />}
              {eyebrow}
            </div>
          )}
          <h1 className="text-2xl md:text-[1.75rem] font-light tracking-tight text-white leading-tight drop-shadow-md">
            {title}
            {accent && <span className="font-semibold"> {accent}</span>}
          </h1>
          {subtitle && (
            <p className="text-white/60 text-sm mt-1 font-light drop-shadow truncate max-w-2xl">
              {subtitle}
            </p>
          )}
        </motion.div>
        {action && <div className="shrink-0 relative z-10 pb-0.5">{action}</div>}
      </div>
    </div>
  );
}
