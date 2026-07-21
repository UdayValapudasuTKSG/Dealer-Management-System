import { useState } from "react";
import { CopilotChat } from "@copilotkit/react-ui";
import { MessageSquare, X, Sparkles } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { SideNav, MobileNav, DealerSwitcher } from "./side-nav";
import { NotificationBell } from "@/components/notification-bell";
import { GlobalSearchButton } from "@/components/global-search";
import { AuraCopilot } from "@/components/copilot/aura-copilot";
import { useAuthz } from "@/lib/auth";

const CONCIERGE_INSTRUCTIONS =
  "You are the AURA Concierge, the always-on operator of a luxury automotive dealership OS. " +
  "You have live context on the manager's current page, the dealership KPIs, and the pending human decision gates. " +
  "Be concise, precise, and proactive. When the manager asks to see or open something, use the navigateTo or openCustomer actions instead of describing where to click. " +
  "When they mention filing duty, clearing a vehicle, or an import document, use the startGraFiling action. " +
  "Never use emojis. Speak like a composed, high-end operations partner.";

export function Shell({ children }: { children: React.ReactNode }) {
  const [chatOpen, setChatOpen] = useState(false);
  // No active dealership (e.g. super admin in the Platform Console) means no
  // CopilotKit provider is mounted, so the concierge must not render at all.
  const { activeDealer } = useAuthz();
  const conciergeAvailable = !!activeDealer;

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden relative selection:bg-primary/30 selection:text-foreground">
      {/* Ambient background glow */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-primary/10 rounded-full blur-[120px] pointer-events-none" />

      <SideNav />

      <div className="flex flex-1 min-h-0 min-w-0 flex-col">
        {/* Slim utility bar */}
        <div className="flex items-center gap-2 px-5 md:px-8 h-14 shrink-0 relative z-20">
          <MobileNav />
          <div className="flex-1" />
          <DealerSwitcher />
          {conciergeAvailable && (
            <>
              <GlobalSearchButton />
              <NotificationBell />
            </>
          )}
        </div>

        <div className="flex flex-1 min-h-0 min-w-0">
        <main className="flex-1 overflow-y-auto relative z-10 scroll-smooth min-w-0">
          <div className="min-h-full h-full">{children}</div>
        </main>

        {/* Right-docked concierge that pushes content */}
        <AnimatePresence initial={false}>
          {conciergeAvailable && chatOpen && (
            <motion.aside
              key="concierge"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 400, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ type: "spring", stiffness: 260, damping: 30 }}
              className="relative z-20 h-full shrink-0 overflow-hidden"
            >
              <div className="h-full w-[400px] flex flex-col rounded-l-3xl border-l border-white/10 bg-background/95 backdrop-blur-2xl shadow-[-24px_0_64px_-24px_rgba(0,0,0,0.8)]">
                <div className="flex items-center justify-between px-5 h-16 border-b border-white/10 shrink-0">
                  <div className="flex items-center gap-2.5">
                    <span className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center">
                      <Sparkles className="w-4 h-4 text-primary" />
                    </span>
                    <div>
                      <div className="text-sm font-semibold tracking-tight">
                        AURA Concierge
                      </div>
                      <div className="text-[10px] uppercase tracking-widest text-primary">
                        Live · Orchestrating
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => setChatOpen(false)}
                    className="w-9 h-9 rounded-full bg-foreground/[0.06] hover:bg-foreground/[0.12] flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                    aria-label="Close concierge"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex-1 min-h-0">
                  <CopilotChat
                    className="h-full"
                    instructions={CONCIERGE_INSTRUCTIONS}
                    labels={{
                      initial:
                        "I run the dealership alongside you. Ask me to open a section, brief you on a decision gate, or start a GRA duty filing.",
                      placeholder: "Ask the concierge to act...",
                    }}
                  />
                </div>
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
        </div>
      </div>

      {/* Floating launcher */}
      <AnimatePresence>
        {conciergeAvailable && !chatOpen && (
          <motion.button
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            onClick={() => setChatOpen(true)}
            className="fixed bottom-6 right-6 z-30 h-14 pl-5 pr-6 rounded-full bg-primary text-white shadow-lg shadow-primary/40 flex items-center gap-2.5 font-medium hover:bg-primary/90 transition-colors glow-brand"
          >
            <MessageSquare className="w-5 h-5" />
            Concierge
          </motion.button>
        )}
      </AnimatePresence>

      {conciergeAvailable && <AuraCopilot />}
    </div>
  );
}
