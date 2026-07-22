import { SignIn } from "@clerk/react";
import { Shield } from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function SignInPage() {
  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background p-4 relative overflow-hidden font-sans accent-blobs">
      <div className="relative z-10 w-full max-w-md">
        <div className="mb-8 text-center glass p-8 rounded-3xl hover-elevate">
          <div className="w-14 h-14 bg-zinc-900 text-white mx-auto flex items-center justify-center mb-6 rounded-2xl shadow-inner">
            <Shield className="w-6 h-6" />
          </div>
          <h1 className="text-4xl font-serif text-zinc-900 mb-2 tracking-tight">AURA Realm</h1>
          <p className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-medium">Network Command Console</p>
        </div>
        <div className="glass p-2 rounded-3xl clerk-container-override hover-elevate">
          <SignIn routing="path" path={`${basePath}/sign-in`} fallbackRedirectUrl={`${basePath}/`} appearance={{
            elements: {
              cardBox: "shadow-none bg-transparent rounded-2xl",
              card: "bg-transparent shadow-none",
              headerTitle: "text-zinc-900 font-serif text-[20px] tracking-tight",
              headerSubtitle: "text-zinc-500 text-[11px]",
              socialButtonsBlockButton: "bg-zinc-50 border-black/10 hover:bg-zinc-100 text-zinc-900 rounded-md h-10",
              socialButtonsBlockButtonText: "font-medium text-[13px]",
              dividerLine: "bg-black/10",
              dividerText: "text-zinc-500 uppercase tracking-widest text-[9px]",
              formFieldLabel: "text-[10px] uppercase tracking-[0.18em] text-zinc-500",
              formFieldInput: "bg-white/50 border-black/10 text-zinc-900 rounded-md h-10 focus:ring-1 focus:ring-black/20 text-[13px]",
              formButtonPrimary: "bg-zinc-900 hover:bg-zinc-700 text-white rounded-md h-10 text-[12.5px] font-medium",
              footerActionLink: "text-zinc-900 hover:text-zinc-700 hover:underline",
              identityPreviewText: "text-zinc-900",
              identityPreviewEditButtonIcon: "text-zinc-500 hover:text-zinc-900",
              formFieldWarningText: "text-rose-500",
              formFieldErrorText: "text-rose-600",
            }
          }} />
        </div>
      </div>
      
      <div className="fixed inset-0 pointer-events-none -z-10 mix-blend-overlay opacity-[0.15]" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noiseFilter%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.65%22 numOctaves=%223%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noiseFilter)%22/%3E%3C/svg%3E")' }}></div>
    </div>
  );
}
