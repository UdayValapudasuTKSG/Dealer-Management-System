import { useEffect, useRef } from "react";
import { Switch, Route, Redirect, useLocation, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ClerkProvider, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import { AuthProvider, useAuthz } from "@/lib/auth";
import { Shell } from "@/components/layout/shell";

import Landing from "@/pages/landing";
import { SignInPage } from "@/pages/auth-pages";
import Dashboard from "@/pages/dashboard";
import Network from "@/pages/network";
import DealerDetail from "@/pages/dealer-detail";
import AgentsPage from "@/pages/agents";
import Users from "@/pages/users";
import Audit from "@/pages/audit";
import AccessDenied from "@/pages/access-denied";
import NotFound from "@/pages/not-found";

/* Live data: visible queries silently re-poll every 10s (paused when the
   tab is hidden), plus refetch on tab focus and page navigation. */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      staleTime: 0,
      refetchInterval: 10 * 1000,
      refetchIntervalInBackground: false,
    },
  },
});

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY");
}

const clerkAppearance = {
  cssLayerName: "clerk",
  variables: {
    colorPrimary: "hsl(0 0% 9%)",
    colorBackground: "hsl(0 0% 98%)",
    colorInput: "hsl(0 0% 90%)",
    colorText: "hsl(0 0% 10%)",
    borderRadius: "0rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-background border border-border shadow-none rounded-none",
    headerTitle: "text-foreground font-serif text-2xl font-normal",
    headerSubtitle: "text-muted-foreground font-sans",
    formButtonPrimary: "bg-primary hover:bg-primary/90 text-primary-foreground rounded-none uppercase tracking-widest text-xs",
    formFieldInput: "rounded-none border-border focus:ring-primary focus:border-primary",
  },
};

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

const testPersonaActive =
  import.meta.env.DEV &&
  (() => {
    try {
      const param = new URLSearchParams(window.location.search).get("test-user");
      if (param === "off") {
        localStorage.removeItem("aura-test-user-email");
      } else if (param) {
        localStorage.setItem("aura-test-user-email", param);
      }
      return !!localStorage.getItem("aura-test-user-email");
    } catch {
      return false;
    }
  })();

function AppShell() {
  if (testPersonaActive) {
    return (
      <AuthProvider>
        <SuperAdminGate>
          <Shell>
            <AppRoutes />
          </Shell>
        </SuperAdminGate>
      </AuthProvider>
    );
  }
  return (
    <>
      <Show when="signed-in">
        <AuthProvider>
          <SuperAdminGate>
            <Shell>
              <AppRoutes />
            </Shell>
          </SuperAdminGate>
        </AuthProvider>
      </Show>
      <Show when="signed-out">
        <Landing />
      </Show>
    </>
  );
}

function SuperAdminGate({ children }: { children: React.ReactNode }) {
  const { me, isLoading } = useAuthz();
  
  if (isLoading) {
    return <div className="min-h-screen bg-background flex items-center justify-center">Loading...</div>;
  }
  
  // Fail closed: no verified super-admin identity means no console access.
  if (!me || !me.isSuperAdmin) {
    return <AccessDenied />;
  }

  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/network" component={Network} />
      <Route path="/network/:id" component={DealerDetail} />
      <Route path="/agents" component={AgentsPage} />
      <Route path="/users" component={Users} />
      <Route path="/audit" component={Audit} />
      <Route component={NotFound} />
    </Switch>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <Switch>
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route>
              <AppShell />
            </Route>
          </Switch>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
