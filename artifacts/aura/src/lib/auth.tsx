import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetCurrentUser } from "@workspace/api-client-react";
import type {
  CurrentUser,
  DealerMembershipInfo,
} from "@workspace/api-client-react";

const DEALER_STORAGE_KEY = "aura-dealer-id";

type AuthContextValue = {
  me: CurrentUser | null;
  isLoading: boolean;
  can: (module: string, category: string) => boolean;
  dealers: DealerMembershipInfo[];
  activeDealer: DealerMembershipInfo | null;
  switchDealer: (dealerId: number) => void;
};

const AuthContext = createContext<AuthContextValue>({
  me: null,
  isLoading: true,
  can: () => false,
  dealers: [],
  activeDealer: null,
  switchDealer: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetCurrentUser();
  const me = data ?? null;

  const dealers = me?.dealers ?? [];
  const activeDealer =
    dealers.find((d) => d.dealerId === me?.activeDealerId) ?? null;

  // Keep localStorage in sync with the server-resolved active dealer so the
  // X-Dealer-Id request header stays valid (e.g. after a membership change).
  useEffect(() => {
    if (me?.activeDealerId != null) {
      localStorage.setItem(DEALER_STORAGE_KEY, String(me.activeDealerId));
    } else if (me && me.activeDealerId == null) {
      localStorage.removeItem(DEALER_STORAGE_KEY);
    }
  }, [me]);

  const switchDealer = useCallback(
    (dealerId: number) => {
      localStorage.setItem(DEALER_STORAGE_KEY, String(dealerId));
      // All cached data belongs to the previous dealer. resetQueries (NOT
      // clear) drops the data AND refetches every active query so mounted
      // pages reload with the new X-Dealer-Id header — clear() alone leaves
      // components showing the old dealer's data until a full page reload.
      void queryClient.resetQueries();
    },
    [queryClient],
  );

  const can = (module: string, category: string) =>
    !!me?.permissions?.some(
      (p) =>
        p.module === module &&
        (p.category === category || p.category === "admin"),
    );

  return (
    <AuthContext.Provider
      value={{ me, isLoading, can, dealers, activeDealer, switchDealer }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuthz() {
  return useContext(AuthContext);
}
