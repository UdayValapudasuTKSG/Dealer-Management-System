import { SignIn } from "@clerk/react";

export function SignInPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4 relative overflow-hidden font-sans">
      <div className="relative z-10 w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="w-16 h-16 bg-black text-white mx-auto flex items-center justify-center mb-6">
            <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </div>
          <h1 className="text-4xl font-serif text-foreground mb-3">AURA Realm</h1>
          <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Network Command Console</p>
        </div>
        <SignIn routing="path" path="/sign-in" />
      </div>
    </div>
  );
}
