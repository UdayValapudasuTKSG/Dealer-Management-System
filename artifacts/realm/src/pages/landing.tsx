import { Link } from "wouter";
import { Shield } from "lucide-react";

export default function Landing() {
  return (
    <div className="min-h-[100dvh] bg-background relative overflow-hidden flex flex-col text-foreground font-sans accent-blobs">
      <header className="px-8 py-6 relative z-10 flex justify-between items-center bg-white/40 backdrop-blur-md border-b border-black/5">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-md bg-zinc-900 flex items-center justify-center">
            <Shield className="w-4 h-4 text-white" />
          </div>
          <span className="font-serif text-[18px] tracking-wide text-zinc-900">AURA Realm</span>
        </div>
        <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">Network Command Console</span>
      </header>

      <main className="flex-1 flex items-center justify-center relative z-10 px-4">
        <div className="text-center max-w-3xl mx-auto glass-strong p-12 sm:p-16 rounded-[2rem] hover-elevate">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-zinc-50 px-3 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-700 mb-8">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            Network Command Active
          </span>
          <h1 className="text-5xl md:text-7xl font-serif text-zinc-900 mb-6 leading-[1.08] tracking-tight">
            The Nerve Center of <br/>
            Modern Dealerships
          </h1>
          <p className="text-[14.5px] text-zinc-600 mb-12 max-w-2xl mx-auto leading-relaxed">
            AURA Realm is the exclusive command console for network operators. 
            Govern AI agents, provision workspaces, and audit platform activity in real-time.
          </p>
          <Link href="/sign-in">
            <button className="inline-flex items-center justify-center rounded-md bg-zinc-900 text-white px-8 py-3 text-[12.5px] font-medium hover:bg-zinc-700 transition-colors shadow-lg">
              Initialize Command
            </button>
          </Link>
        </div>
      </main>

      {/* Decorative noise/gradient behind */}
      <div className="fixed inset-0 pointer-events-none -z-10 mix-blend-overlay opacity-[0.15]" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noiseFilter%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.65%22 numOctaves=%223%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noiseFilter)%22/%3E%3C/svg%3E")' }}></div>
    </div>
  );
}
