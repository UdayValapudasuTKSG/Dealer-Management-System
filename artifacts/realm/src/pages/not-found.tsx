import { AlertCircle, ArrowLeft } from "lucide-react";
import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background font-sans p-4 relative">
      <div className="w-full max-w-md mx-4 glass-panel rounded-3xl p-10 flex flex-col items-center text-center relative z-10">
        <div className="w-16 h-16 mb-8 rounded-2xl border border-white/10 flex items-center justify-center bg-white/[0.04] shadow-inner">
          <AlertCircle className="h-8 w-8 text-foreground opacity-80" />
        </div>
        <h1 className="text-3xl font-serif text-white mb-4 tracking-wide">System Malfunction</h1>
        <p className="text-sm text-muted-foreground mb-8 font-light leading-relaxed px-4">
          The requested platform sector could not be located.
        </p>
        <Link href="/" className="w-full flex items-center justify-center gap-2 h-12 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-[10px] uppercase tracking-widest text-foreground transition-colors">
          <ArrowLeft className="w-3.5 h-3.5 opacity-70" /> Return to Overview
        </Link>
      </div>

      <div className="fixed inset-0 pointer-events-none -z-10 mix-blend-overlay opacity-20" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noiseFilter%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.65%22 numOctaves=%223%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noiseFilter)%22/%3E%3C/svg%3E")' }}></div>
    </div>
  );
}

