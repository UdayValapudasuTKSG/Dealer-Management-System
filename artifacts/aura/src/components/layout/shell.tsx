import { CopilotPopup } from "@copilotkit/react-ui";
import { Sidebar } from "./sidebar";
import { AuraCopilot } from "@/components/copilot/aura-copilot";

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-full bg-background overflow-hidden relative selection:bg-primary/20 selection:text-primary">
      {/* Ambient background glow */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />

      <Sidebar />

      <main className="flex-1 overflow-y-auto relative z-10 scroll-smooth">
        <div className="min-h-full h-full">
          {children}
        </div>
      </main>

      <AuraCopilot />
      <CopilotPopup
        clickOutsideToClose
        labels={{
          title: "AURA Concierge",
          initial:
            "I run the dealership alongside you. Ask me to open a section, brief you on a decision gate, or start a GRA duty filing.",
          placeholder: "Ask the concierge to act...",
        }}
        instructions={
          "You are the AURA Concierge, the always-on operator of a luxury automotive dealership OS. " +
          "You have live context on the manager's current page, the dealership KPIs, and the pending human decision gates. " +
          "Be concise, precise, and proactive. When the manager asks to see or open something, use the navigateTo or openCustomer actions instead of describing where to click. " +
          "When they mention filing duty, clearing a vehicle, or an import document, use the startGraFiling action. " +
          "Never use emojis. Speak like a composed, high-end operations partner."
        }
      />
    </div>
  );
}
