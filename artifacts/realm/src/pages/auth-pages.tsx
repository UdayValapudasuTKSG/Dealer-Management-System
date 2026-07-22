import { SignIn } from "@clerk/react";

export function SignInPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4 relative overflow-hidden">
      {/* Decorative background elements */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/20 rounded-full blur-[120px] pointer-events-none" />
      
      <div className="relative z-10 w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="w-16 h-16 bg-primary/20 rounded-2xl mx-auto flex items-center justify-center mb-4 border border-primary/30">
            <svg className="w-8 h-8 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-white mb-2">AURA Realm</h1>
          <p className="text-muted-foreground">Network Command Console</p>
        </div>
        <SignIn routing="path" path="/sign-in" />
      </div>
    </div>
  );
}
