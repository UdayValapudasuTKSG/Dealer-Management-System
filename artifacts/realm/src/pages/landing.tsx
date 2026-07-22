import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function Landing() {
  return (
    <div className="min-h-screen bg-background relative overflow-hidden flex flex-col">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/15 via-background to-background pointer-events-none" />
      
      <header className="px-8 py-6 relative z-10 flex justify-between items-center border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-primary/20 rounded flex items-center justify-center border border-primary/30">
            <svg className="w-4 h-4 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </div>
          <span className="font-semibold text-lg tracking-wide text-white">AURA Realm</span>
        </div>
        <Link href="/sign-in">
          <Button variant="outline" className="border-primary/50 text-primary hover:bg-primary hover:text-white transition-colors">
            Operator Access
          </Button>
        </Link>
      </header>

      <main className="flex-1 flex items-center justify-center relative z-10 px-4">
        <div className="text-center max-w-3xl mx-auto">
          <Badge className="mb-6 bg-primary/10 text-primary hover:bg-primary/20 border-primary/20 px-4 py-1.5 text-sm">
            Network Command Active
          </Badge>
          <h1 className="text-5xl md:text-7xl font-bold tracking-tighter text-white mb-6">
            The Nerve Center of <br/>
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-cyan-300">Modern Dealerships</span>
          </h1>
          <p className="text-xl text-muted-foreground mb-10 max-w-2xl mx-auto leading-relaxed">
            AURA Realm is the exclusive command console for network operators. 
            Govern AI agents, provision workspaces, and audit platform activity in real-time.
          </p>
          <Link href="/sign-in">
            <Button size="lg" className="h-14 px-8 text-base bg-primary text-primary-foreground hover:bg-primary/90 font-medium tracking-wide shadow-[0_0_40px_rgba(0,188,255,0.3)] hover:shadow-[0_0_60px_rgba(0,188,255,0.5)] transition-all">
              Initialize Command
            </Button>
          </Link>
        </div>
      </main>

      <div className="h-px w-full bg-gradient-to-r from-transparent via-primary/30 to-transparent absolute bottom-0" />
    </div>
  );
}

function Badge({ className, children }: { className?: string, children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-full border font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${className}`}>{children}</span>
}
