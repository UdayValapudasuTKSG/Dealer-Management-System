import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetCurrentUser, startImpersonation } from "@workspace/api-client-react";
import type {
  CurrentUser,
  DealerMembershipInfo,
} from "@workspace/api-client-react";

const DEALER_STORAGE_KEY = "aura-dealer-id";

type AuthContextValue = {
  me: CurrentUser | null;
  isLoading: boolean;
  can: (module: string, category: string) => boolean;
  /** Per-dealer feature flag: missing key = enabled. */
  entitled: (key: string) => boolean;
  dealers: DealerMembershipInfo[];
  activeDealer: DealerMembershipInfo | null;
  switchDealer: (dealerId: number) => void | Promise<void>;
};

const AuthContext = createContext<AuthContextValue>({
  me: null,
  isLoading: true,
  can: () => false,
  entitled: () => true,
  dealers: [],
  activeDealer: null,
  switchDealer: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useGetCurrentUser();
  const me = data ?? null;

  const dealers = me?.dealers ?? [];
  const activeDealer =
    dealers.find((d) => d.dealerId === me?.activeDealerId) ?? null;

  // Keep localStorage in sync with the server-resolved active dealer so the
  // X-Dealer-Id request header stays valid (e.g. after a membership change).
  useEffect(() => {
    if (me?.activeDealerId != null) {
      const previous = localStorage.getItem(DEALER_STORAGE_KEY);
      localStorage.setItem(DEALER_STORAGE_KEY, String(me.activeDealerId));
      // Queries that fired BEFORE the dealer context resolved failed with
      // dealer_selection_required and would otherwise stay stuck in their
      // error state (pages render "not found" until a manual refresh).
      // Once the active dealer lands, re-run every errored query so the
      // app self-heals from the startup race.
      if (previous !== String(me.activeDealerId)) {
        void queryClient.refetchQueries({
          predicate: (q) => q.state.status === "error",
        });
      } else {
        void queryClient.refetchQueries({
          predicate: (q) =>
            q.state.status === "error" &&
            (q.state.error as { data?: { code?: string } } | null)?.data
              ?.code === "dealer_selection_required",
        });
      }
    } else if (me && me.activeDealerId == null) {
      localStorage.removeItem(DEALER_STORAGE_KEY);
    }
  }, [me, queryClient]);

  // Self-heal a stale x-dealer-id: if the stored dealer no longer resolves
  // (membership removed → 404, or a super admin's impersonation grant
  // expired → 403), clear it and retry so the user lands on the picker /
  // console instead of a dead app.
  useEffect(() => {
    if (!error) return;
    const status = (error as { status?: number }).status;
    if (
      (status === 404 || status === 403) &&
      localStorage.getItem(DEALER_STORAGE_KEY)
    ) {
      localStorage.removeItem(DEALER_STORAGE_KEY);
      void queryClient.resetQueries();
    }
  }, [error, queryClient]);

  const switchDealer = useCallback(
    async (dealerId: number) => {
      // Super admins need an explicit, audited impersonation grant before
      // the server will bind them to a dealership workspace.
      if (me?.isSuperAdmin) {
        try {
          await startImpersonation({
            dealerId,
            reason: "Workspace switch from AURA dealer picker",
            mode: "read_only",
          });
        } catch {
          return; // grant refused — stay where we are
        }
      }
      localStorage.setItem(DEALER_STORAGE_KEY, String(dealerId));
      // All cached data belongs to the previous dealer. resetQueries (NOT
      // clear) drops the data AND refetches every active query so mounted
      // pages reload with the new X-Dealer-Id header — clear() alone leaves
      // components showing the old dealer's data until a full page reload.
      void queryClient.resetQueries();
    },
    [queryClient, me?.isSuperAdmin],
  );

  // "view" is the master visibility switch for a module — it must be granted
  // explicitly and is NOT implied by "admin". Other categories are still
  // implied by "admin".
  const can = (module: string, category: string) =>
    !!me?.permissions?.some(
      (p) =>
        p.module === module &&
        (p.category === category ||
          (p.category === "admin" && category !== "view")),
    );

  // Missing key = enabled (per-dealer entitlements are deny-list flags).
  const entitled = (key: string) => {
    const flags = me?.entitlements as Record<string, boolean> | undefined;
    return flags?.[key] !== false;
  };

  return (
    <AuthContext.Provider
      value={{ me, isLoading, can, entitled, dealers, activeDealer, switchDealer }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuthz() {
  return useContext(AuthContext);
}
