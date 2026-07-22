import { ShieldX, ArrowLeft } from "lucide-react";

export default function AccessDenied() {
  return (
    <div className="min-h-[100dvh] bg-background flex flex-col items-center justify-center p-4 font-sans accent-blobs">
      <div className="max-w-md w-full text-center space-y-8 glass p-10 rounded-[2rem] hover-elevate">
        <div className="w-16 h-16 rounded-2xl bg-zinc-100 text-zinc-400 flex items-center justify-center mx-auto border border-black/5 shadow-inner">
          <ShieldX className="w-8 h-8" />
        </div>
        
        <div className="space-y-3">
          <h1 className="text-4xl font-serif tracking-tight text-zinc-900">Access Denied</h1>
          <p className="text-[13.5px] text-zinc-600 leading-relaxed px-4">
            AURA Realm is restricted to platform operators and super administrators. Your account does not have the required clearance.
          </p>
        </div>

        <div className="pt-8 border-t border-black/5">
          <a href="/" className="inline-flex items-center justify-center w-full bg-white/70 hover:bg-white text-zinc-800 border border-black/10 rounded-md uppercase tracking-widest text-[10px] font-medium h-10 transition-colors">
            <ArrowLeft className="w-3.5 h-3.5 mr-2" />
            Return to Dealership Platform
          </a>
        </div>
      </div>
    </div>
  );
}
