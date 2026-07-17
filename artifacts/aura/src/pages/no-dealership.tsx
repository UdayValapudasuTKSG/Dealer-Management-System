import { Building2, LogOut } from "lucide-react";
import { useClerk } from "@clerk/react";
import { recordLogoutEvent } from "@workspace/api-client-react";
import { useAuthz } from "@/lib/auth";

export default function NoDealership() {
  const { me } = useAuthz();
  const { signOut } = useClerk();

  const handleSignOut = async () => {
    try {
      await recordLogoutEvent();
    } catch {
      // best-effort audit; never block sign-out
    }
    await signOut({ redirectUrl: import.meta.env.BASE_URL || "/" });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6">
      <div className="max-w-md w-full text-center glass-panel rounded-2xl border border-white/10 p-10">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/15 ring-1 ring-primary/25">
          <Building2 className="h-8 w-8 text-primary" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">
          No dealership assigned
        </h1>
        <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
          Your account{me?.email ? ` (${me.email})` : ""} isn&apos;t a member of
          any dealership yet. Ask your General Manager or the platform
          administrator to add you to a dealership, then sign in again.
        </p>
        <button
          onClick={handleSignOut}
          className="mt-8 inline-flex items-center gap-2 rounded-full bg-primary px-6 py-2.5 text-sm font-semibold text-white hover:bg-primary/90 transition-colors"
        >
          <LogOut className="h-4 w-4" /> Sign out
        </button>
      </div>
    </div>
  );
}
