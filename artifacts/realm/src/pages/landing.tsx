import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Shield } from "lucide-react";

export default function Landing() {
  return (
    <div className="min-h-[100dvh] bg-background relative overflow-hidden flex flex-col text-foreground font-sans">
      <header className="px-8 py-6 relative z-10 flex justify-between items-center bg-white/[0.02] backdrop-blur-md border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-white/[0.05] border border-white/10 flex items-center justify-center">
            <Shield className="w-4 h-4 text-white" />
          </div>
          <span className="font-serif text-xl tracking-wide text-white">AURA Realm</span>
        </div>
        <Link href="/sign-in">
          <Button variant="outline" className="border-white/20 text-foreground hover:bg-white/10 hover:text-white transition-colors rounded-xl uppercase tracking-widest text-[10px] h-10 px-5">
            Operator Access
          </Button>
        </Link>
      </header>

      <main className="flex-1 flex items-center justify-center relative z-10 px-4">
        <div className="text-center max-w-3xl mx-auto glass-panel p-12 sm:p-16 rounded-3xl">
          <Badge className="mb-8 bg-white/10 text-foreground border-white/10 px-4 py-1.5 text-[10px] uppercase tracking-[0.25em] rounded-full">
            Network Command Active
          </Badge>
          <h1 className="text-5xl md:text-7xl font-serif text-white mb-6 leading-tight tracking-tight">
            The Nerve Center of <br/>
            Modern Dealerships
          </h1>
          <p className="text-lg text-muted-foreground mb-12 max-w-2xl mx-auto leading-relaxed font-sans font-light">
            AURA Realm is the exclusive command console for network operators. 
            Govern AI agents, provision workspaces, and audit platform activity in real-time.
          </p>
          <Link href="/sign-in">
            <Button size="lg" className="h-14 px-8 text-[11px] uppercase tracking-widest bg-primary text-primary-foreground hover:bg-primary/90 transition-all rounded-xl shadow-xl shadow-white/5">
              Initialize Command
            </Button>
          </Link>
        </div>
      </main>

      {/* Decorative noise/gradient behind */}
      <div className="fixed inset-0 pointer-events-none -z-10 mix-blend-overlay opacity-20" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noiseFilter%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.65%22 numOctaves=%223%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noiseFilter)%22/%3E%3C/svg%3E")' }}></div>
    </div>
  );
}

function Badge({ className, children }: { className?: string, children: React.ReactNode }) {
  return <span className={`inline-flex items-center border font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${className}`}>{children}</span>
}

