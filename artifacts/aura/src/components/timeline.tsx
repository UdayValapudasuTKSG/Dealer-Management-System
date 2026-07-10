import { motion } from "framer-motion";
import { formatDistanceToNow } from "date-fns";
import type { TimelineEvent } from "@workspace/api-client-react";
import {
  Users,
  Briefcase,
  Banknote,
  Calculator,
  Wrench,
  Car,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

const DOMAIN_ICON: Record<string, typeof Users> = {
  leads: Users,
  deals: Briefcase,
  finance: Banknote,
  appraisals: Calculator,
  service: Wrench,
  vehicles: Car,
  gate: ShieldCheck,
  system: Sparkles,
};

export function Timeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground font-light">
        No activity yet.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {events.map((event, i) => {
        const Icon = DOMAIN_ICON[event.domain] ?? Sparkles;
        const isGate = event.domain === "gate";
        return (
          <motion.div
            key={event.id}
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: Math.min(i * 0.04, 0.4) }}
            className="flex gap-4 relative pb-6"
          >
            {i !== events.length - 1 && (
              <div className="absolute top-9 bottom-0 left-[15px] w-px bg-border/70" />
            )}
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 z-10 shadow-sm ${
                isGate
                  ? "bg-primary text-white"
                  : event.isAgent
                    ? "bg-primary/10 text-primary"
                    : "bg-black/5 text-foreground"
              }`}
            >
              <Icon className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm font-semibold leading-snug">
                  {event.title}
                </p>
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider shrink-0">
                  {formatDistanceToNow(new Date(event.createdAt), {
                    addSuffix: true,
                  })}
                </span>
              </div>
              {event.detail && (
                <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                  {event.detail}
                </p>
              )}
              <div className="flex items-center gap-2 mt-2 text-[10px] uppercase tracking-widest text-muted-foreground">
                <span className="font-medium">{event.actor}</span>
                {event.cause && (
                  <>
                    <span className="w-1 h-1 rounded-full bg-border" />
                    <span className="normal-case tracking-normal text-muted-foreground/80">
                      because {event.cause}
                    </span>
                  </>
                )}
              </div>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
