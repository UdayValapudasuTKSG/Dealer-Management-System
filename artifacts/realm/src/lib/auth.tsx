import { createContext, useContext, ReactNode } from "react";
import { useGetCurrentUser } from "@workspace/api-client-react";
import type { CurrentUser } from "@workspace/api-client-react";

type AuthContextValue = {
  me: CurrentUser | null;
  isLoading: boolean;
};

const AuthContext = createContext<AuthContextValue>({
  me: null,
  isLoading: true,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = useGetCurrentUser();
  const me = data ?? null;

  return (
    <AuthContext.Provider value={{ me, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuthz() {
  return useContext(AuthContext);
}
