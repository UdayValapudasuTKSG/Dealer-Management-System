import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function Landing() {
  return (
    <div className="min-h-screen bg-background relative overflow-hidden flex flex-col text-foreground font-sans">
      <header className="px-8 py-6 relative z-10 flex justify-between items-center border-b border-border bg-white">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-black text-white flex items-center justify-center">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </div>
          <span className="font-serif text-xl tracking-wide text-black">AURA Realm</span>
        </div>
        <Link href="/sign-in">
          <Button variant="outline" className="border-black text-black hover:bg-black hover:text-white transition-colors rounded-none uppercase tracking-widest text-xs">
            Operator Access
          </Button>
        </Link>
      </header>

      <main className="flex-1 flex items-center justify-center relative z-10 px-4">
        <div className="text-center max-w-3xl mx-auto">
          <Badge className="mb-6 bg-black text-white hover:bg-black/90 border-transparent px-4 py-1.5 text-[10px] uppercase tracking-[0.2em] rounded-none">
            Network Command Active
          </Badge>
          <h1 className="text-5xl md:text-7xl font-serif text-black mb-6 leading-tight">
            The Nerve Center of <br/>
            Modern Dealerships
          </h1>
          <p className="text-lg text-muted-foreground mb-10 max-w-2xl mx-auto leading-relaxed font-sans">
            AURA Realm is the exclusive command console for network operators. 
            Govern AI agents, provision workspaces, and audit platform activity in real-time.
          </p>
          <Link href="/sign-in">
            <Button size="lg" className="h-14 px-8 text-xs uppercase tracking-widest bg-black text-white hover:bg-black/90 font-medium transition-all rounded-none">
              Initialize Command
            </Button>
          </Link>
        </div>
      </main>

      <div className="h-px w-full bg-border absolute bottom-0" />
    </div>
  );
}

function Badge({ className, children }: { className?: string, children: React.ReactNode }) {
  return <span className={`inline-flex items-center border font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${className}`}>{children}</span>
}
