import { createContext, useContext, type ReactNode } from "react";
import { useGetCurrentUser } from "@workspace/api-client-react";
import type { CurrentUser } from "@workspace/api-client-react";

type AuthContextValue = {
  me: CurrentUser | null;
  isLoading: boolean;
  can: (module: string, category: string) => boolean;
};

const AuthContext = createContext<AuthContextValue>({
  me: null,
  isLoading: true,
  can: () => false,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = useGetCurrentUser();
  const me = data ?? null;

  const can = (module: string, category: string) =>
    !!me?.permissions?.some(
      (p) =>
        p.module === module &&
        (p.category === category || p.category === "admin"),
    );

  return (
    <AuthContext.Provider value={{ me, isLoading, can }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuthz() {
  return useContext(AuthContext);
}
