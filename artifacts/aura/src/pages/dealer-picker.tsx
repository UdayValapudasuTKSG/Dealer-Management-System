import { Building2, LogOut, ChevronRight, PauseCircle } from "lucide-react";
import { useClerk } from "@clerk/react";
import { recordLogoutEvent } from "@workspace/api-client-react";
import { useAuthz } from "@/lib/auth";

function useSignOutAll() {
  const { signOut } = useClerk();
  return async () => {
    try {
      await recordLogoutEvent();
    } catch {
      // best-effort audit; never block sign-out
    }
    await signOut({ redirectUrl: import.meta.env.BASE_URL || "/" });
  };
}

/** Shown when a signed-in user belongs to several dealerships and no active
 *  workspace is bound yet — the server never auto-picks one silently. */
export default function DealerPicker() {
  const { me, dealers, switchDealer } = useAuthz();
  const handleSignOut = useSignOutAll();

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6">
      <div className="max-w-md w-full glass-panel rounded-2xl border border-white/10 p-8">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 ring-1 ring-primary/25">
          <Building2 className="h-7 w-7 text-primary" />
        </div>
        <h1 className="text-xl font-bold tracking-tight text-center">
          Choose your dealership
        </h1>
        <p className="mt-2 text-sm text-muted-foreground text-center">
          {me?.email ? `${me.email} belongs` : "You belong"} to more than one
          dealership. Pick the workspace you want to work in.
        </p>
        <div className="mt-6 space-y-2">
          {dealers.map((d) => {
            const suspended = d.dealerStatus === "suspended";
            return (
              <button
                key={d.dealerId}
                disabled={suspended}
                onClick={() => switchDealer(d.dealerId)}
                className="w-full flex items-center gap-3 rounded-xl border border-white/10 bg-foreground/[0.03] hover:bg-foreground/[0.06] disabled:opacity-50 disabled:cursor-not-allowed px-4 py-3 text-left transition-colors"
              >
                <Building2 className="h-5 w-5 text-primary shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-semibold truncate">
                    {d.dealerName}
                  </span>
                  <span className="block text-xs text-muted-foreground truncate">
                    {suspended ? "Suspended" : d.roleName ?? "Member"}
                  </span>
                </span>
                {suspended ? (
                  <PauseCircle className="h-4 w-4 text-amber-400 shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
              </button>
            );
          })}
        </div>
        <button
          onClick={handleSignOut}
          className="mt-6 w-full inline-flex items-center justify-center gap-2 rounded-full border border-white/10 px-6 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <LogOut className="h-4 w-4" /> Sign out
        </button>
      </div>
    </div>
  );
}

/** Shown when the bound dealership is suspended — data plane is frozen. */
export function DealerSuspended({ dealerName }: { dealerName?: string }) {
  const handleSignOut = useSignOutAll();
  const { me, dealers, switchDealer } = useAuthz();
  const others = dealers.filter(
    (d) => d.dealerStatus !== "suspended" && d.dealerId !== me?.activeDealerId,
  );

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6">
      <div className="max-w-md w-full text-center glass-panel rounded-2xl border border-white/10 p-10">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-500/15 ring-1 ring-amber-500/25">
          <PauseCircle className="h-8 w-8 text-amber-400" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">
          Dealership suspended
        </h1>
        <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
          {dealerName ?? "This dealership"} has been suspended by the platform
          administrator. Its data and AI agents are frozen until it is
          reactivated. Contact the platform administrator for details.
        </p>
        {others.length > 0 && (
          <div className="mt-6 space-y-2">
            {others.map((d) => (
              <button
                key={d.dealerId}
                onClick={() => switchDealer(d.dealerId)}
                className="w-full flex items-center gap-3 rounded-xl border border-white/10 bg-foreground/[0.03] hover:bg-foreground/[0.06] px-4 py-3 text-left transition-colors"
              >
                <Building2 className="h-5 w-5 text-primary shrink-0" />
                <span className="flex-1 text-sm font-semibold truncate">
                  Switch to {d.dealerName}
                </span>
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              </button>
            ))}
          </div>
        )}
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
