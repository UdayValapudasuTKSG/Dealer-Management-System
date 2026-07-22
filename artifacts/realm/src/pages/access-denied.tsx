import { Button } from "@/components/ui/button";
import { ShieldX, ArrowLeft } from "lucide-react";

export default function AccessDenied() {
  return (
    <div className="min-h-[100dvh] bg-background flex flex-col items-center justify-center p-4 font-sans">
      <div className="max-w-md w-full text-center space-y-8 glass-panel p-10 rounded-3xl">
        <div className="w-20 h-20 rounded-2xl bg-white/[0.04] text-foreground flex items-center justify-center mx-auto border border-white/10 shadow-inner">
          <ShieldX className="w-8 h-8 opacity-80" />
        </div>
        
        <div className="space-y-4">
          <h1 className="text-4xl font-serif tracking-tight text-white">Access Denied</h1>
          <p className="text-sm text-muted-foreground leading-relaxed font-light px-4">
            AURA Realm is restricted to platform operators and super administrators. Your account does not have the required clearance.
          </p>
        </div>

        <div className="pt-8 border-t border-white/5">
          <Button asChild className="w-full bg-white/5 hover:bg-white/10 text-foreground border border-white/10 rounded-xl uppercase tracking-widest text-[10px] h-12" variant="outline">
            <a href="/">
              <ArrowLeft className="w-4 h-4 mr-2 opacity-70" />
              Return to Dealership Platform
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}

