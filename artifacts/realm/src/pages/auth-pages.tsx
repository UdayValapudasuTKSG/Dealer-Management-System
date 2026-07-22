import { SignIn } from "@clerk/react";
import { Shield } from "lucide-react";

export function SignInPage() {
  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background p-4 relative overflow-hidden font-sans">
      <div className="relative z-10 w-full max-w-md">
        <div className="mb-8 text-center glass-panel p-8 rounded-3xl">
          <div className="w-16 h-16 bg-white/[0.04] text-foreground mx-auto flex items-center justify-center mb-6 rounded-2xl border border-white/10 shadow-inner">
            <Shield className="w-8 h-8 opacity-80" />
          </div>
          <h1 className="text-4xl font-serif text-white mb-3 tracking-tight">AURA Realm</h1>
          <p className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground font-medium">Network Command Console</p>
        </div>
        <div className="glass-panel p-2 rounded-[2rem] clerk-container-override">
          <SignIn routing="path" path="/sign-in" appearance={{
            elements: {
              cardBox: "shadow-none bg-transparent rounded-3xl",
              card: "bg-transparent shadow-none",
              headerTitle: "text-foreground font-serif text-2xl tracking-wide",
              headerSubtitle: "text-muted-foreground text-xs uppercase tracking-widest",
              socialButtonsBlockButton: "bg-white/[0.03] border-white/10 hover:bg-white/[0.06] text-foreground rounded-xl h-11",
              socialButtonsBlockButtonText: "font-medium",
              dividerLine: "bg-white/10",
              dividerText: "text-muted-foreground uppercase tracking-widest text-[9px]",
              formFieldLabel: "text-[10px] uppercase tracking-[0.2em] text-muted-foreground",
              formFieldInput: "bg-white/5 border-white/10 text-foreground rounded-xl h-11 focus:ring-1 focus:ring-white/30",
              formButtonPrimary: "bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl h-11 uppercase tracking-widest text-[11px]",
              footerActionLink: "text-foreground hover:text-foreground/80 hover:underline",
              identityPreviewText: "text-foreground",
              identityPreviewEditButtonIcon: "text-muted-foreground hover:text-foreground",
              formFieldWarningText: "text-red-400",
              formFieldErrorText: "text-red-400",
            }
          }} />
        </div>
      </div>
      
      {/* Decorative noise/gradient behind */}
      <div className="fixed inset-0 pointer-events-none -z-10 mix-blend-overlay opacity-20" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noiseFilter%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.65%22 numOctaves=%223%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noiseFilter)%22/%3E%3C/svg%3E")' }}></div>
    </div>
  );
}

