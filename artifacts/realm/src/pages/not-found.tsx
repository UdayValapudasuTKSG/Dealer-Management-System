import { AlertCircle, ArrowLeft } from "lucide-react";
import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background font-sans p-4 relative accent-blobs">
      <div className="w-full max-w-md mx-4 glass rounded-[2rem] p-10 flex flex-col items-center text-center relative z-10 hover-elevate">
        <div className="w-16 h-16 mb-6 rounded-2xl border border-black/5 flex items-center justify-center bg-zinc-100 shadow-inner">
          <AlertCircle className="h-8 w-8 text-zinc-400" />
        </div>
        <h1 className="text-3xl font-serif text-zinc-900 mb-3 tracking-tight">System Malfunction</h1>
        <p className="text-[13.5px] text-zinc-600 mb-8 leading-relaxed px-4">
          The requested platform sector could not be located.
        </p>
        <Link href="/" className="w-full flex items-center justify-center gap-2 h-10 rounded-md bg-white/70 hover:bg-white border border-black/10 text-[10px] uppercase tracking-widest font-medium text-zinc-800 transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> Return to Overview
        </Link>
      </div>

      <div className="fixed inset-0 pointer-events-none -z-10 mix-blend-overlay opacity-[0.15]" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noiseFilter%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.65%22 numOctaves=%223%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noiseFilter)%22/%3E%3C/svg%3E")' }}></div>
    </div>
  );
}
