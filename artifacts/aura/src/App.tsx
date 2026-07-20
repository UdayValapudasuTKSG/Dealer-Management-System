import { useEffect, useRef } from "react";
import { Switch, Route, Redirect, useLocation, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ClerkProvider, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { dark } from "@clerk/themes";
import { CopilotKit } from "@copilotkit/react-core";
import "@copilotkit/react-ui/styles.css";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Shell } from "@/components/layout/shell";
import { AuthProvider, useAuthz } from "@/lib/auth";
import { SignInPage, SignUpPage } from "@/pages/auth-pages";

import Landing from "@/pages/landing";
import BookTestDrive from "@/pages/book-test-drive";
import RoleDashboard from "@/pages/role-dashboard";
import Reports from "@/pages/reports";
import Inventory from "@/pages/inventory";
import Leads from "@/pages/leads";
import Deals from "@/pages/deals";
import Finance from "@/pages/finance";
import Service from "@/pages/service";
import Parts from "@/pages/parts";
import Workshop from "@/pages/workshop";
import Deliveries from "@/pages/deliveries";
import Customers from "@/pages/customers";
import CustomerDetail from "@/pages/customer-detail";
import LeadDetail from "@/pages/lead-detail";
import VehicleDetailPage from "@/pages/vehicle-detail";
import TeamProfile from "@/pages/team-profile";
import Approvals from "@/pages/approvals";
import Gra from "@/pages/gra";
import Tasks from "@/pages/tasks";
import SettingsUsers from "@/pages/settings-users";
import SettingsEmail from "@/pages/settings-email";
import SettingsRoles from "@/pages/settings-roles";
import SettingsAudit from "@/pages/settings-audit";
import NotFound from "@/pages/not-found";
import AdminPage from "@/pages/admin";
import NoDealership from "@/pages/no-dealership";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    },
  },
});

// REQUIRED — copy verbatim. Resolves the key from window.location.hostname so the
// same build serves multiple Clerk custom domains.
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

// REQUIRED — empty in dev (Clerk hits dev FAPI directly), auto-set in prod.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// Clerk passes full paths to routerPush/routerReplace, but wouter's
// setLocation prepends the base — strip it to avoid doubling.
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY");
}

const clerkAppearance = {
  theme: dark,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "hsl(218 72% 50%)",
    colorForeground: "hsl(0 0% 96%)",
    colorMutedForeground: "hsl(0 0% 62%)",
    colorDanger: "hsl(0 82% 55%)",
    colorBackground: "hsl(0 0% 7%)",
    colorInput: "hsl(0 0% 11%)",
    colorInputForeground: "hsl(0 0% 96%)",
    colorNeutral: "hsl(0 0% 80%)",
    fontFamily: "'Outfit', sans-serif",
    borderRadius: "0.75rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox:
      "bg-[hsl(0_0%_7%)] rounded-2xl w-[440px] max-w-full overflow-hidden border border-white/10 shadow-[0_30px_80px_-30px_rgba(224,19,19,0.35)]",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-white font-semibold tracking-tight",
    headerSubtitle: "text-neutral-400",
    socialButtonsBlockButtonText: "text-white",
    formFieldLabel: "text-neutral-300",
    footerActionLink: "text-[hsl(0_82%_55%)] hover:text-[hsl(0_82%_65%)]",
    footerActionText: "text-neutral-400",
    dividerText: "text-neutral-500",
    identityPreviewEditButton: "text-[hsl(0_82%_55%)]",
    formFieldSuccessText: "text-emerald-400",
    alertText: "text-red-300",
    logoBox: "justify-center",
    logoImage: "h-10",
    socialButtonsBlockButton:
      "bg-white/[0.04] border border-white/10 hover:bg-white/[0.08] text-white",
    formButtonPrimary:
      "bg-[hsl(0_82%_44%)] hover:bg-[hsl(0_82%_50%)] text-white shadow-lg shadow-red-900/40",
    formFieldInput: "bg-white/[0.04] border-white/10 text-white",
    footerAction: "justify-center",
    dividerLine: "bg-white/10",
    alert: "bg-red-950/40 border border-red-900/40",
    otpCodeFieldInput: "bg-white/[0.04] border-white/10 text-white",
    formFieldRow: "gap-2",
    main: "gap-5",
  },
};

// Helps the webview stay up-to-date when the signed-in user changes.
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

function AppShell() {
  return (
    <>
      <Show when="signed-in">
        <AuthProvider>
          <DealershipGate>
          <CopilotKit runtimeUrl={`${import.meta.env.BASE_URL}api/copilotkit`}>
            <Shell>
              <Switch>
                <Route path="/admin">
                  <RequireSuperAdmin>
                    <AdminPage />
                  </RequireSuperAdmin>
                </Route>
                <Route path="/pipeline" component={Leads} />
                <Route path="/leads" component={Leads} />
                <Route path="/command-center" component={RoleDashboard} />
                <Route path="/reports" component={Reports} />
                <Route path="/inventory" component={Inventory} />
                <Route path="/deals" component={Deals} />
                <Route path="/finance" component={Finance} />
                <Route path="/service" component={Service} />
                <Route path="/parts" component={Parts} />
                <Route path="/workshop" component={Workshop} />
                <Route path="/deliveries" component={Deliveries} />
                <Route path="/approvals" component={Approvals} />
                <Route path="/customers" component={Customers} />
                <Route path="/customers/:id" component={CustomerDetail} />
                <Route path="/lead/:id" component={LeadDetail} />
                <Route path="/vehicle/:id" component={VehicleDetailPage} />
                <Route path="/team/:id" component={TeamProfile} />
                <Route path="/tasks" component={Tasks} />
                <Route path="/gra" component={Gra} />
                <Route path="/settings/users">
                  <RequireSettings>
                    <SettingsUsers />
                  </RequireSettings>
                </Route>
                <Route path="/settings/roles">
                  <RequireSettings>
                    <SettingsRoles />
                  </RequireSettings>
                </Route>
                <Route path="/settings/audit">
                  <RequireSettings>
                    <SettingsAudit />
                  </RequireSettings>
                </Route>
                <Route path="/settings/email">
                  <RequireSettings>
                    <SettingsEmail />
                  </RequireSettings>
                </Route>
                <Route path="/settings">
                  <Redirect to="/settings/users" />
                </Route>
                <Route component={NotFound} />
              </Switch>
            </Shell>
          </CopilotKit>
          </DealershipGate>
        </AuthProvider>
      </Show>
      <Show when="signed-out">
        <RedirectToSignInPage />
      </Show>
    </>
  );
}

// Signed-in users without any dealership membership see a dedicated screen
// (the first-user-becomes-GM rule is retired). Super admins always pass.
function DealershipGate({ children }: { children: React.ReactNode }) {
  const { me, isLoading } = useAuthz();
  if (!isLoading && me && !me.isSuperAdmin && me.activeDealerId == null) {
    return <NoDealership />;
  }
  return <>{children}</>;
}

function RequireSuperAdmin({ children }: { children: React.ReactNode }) {
  const { me } = useAuthz();
  if (me && !me.isSuperAdmin) {
    return (
      <div className="p-8 flex flex-col items-center justify-center min-h-[50vh] text-center">
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-8 py-10 max-w-md">
          <h2 className="text-xl font-bold tracking-tight">Access denied</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Platform administration is restricted to the super admin.
          </p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

function RequireSettings({ children }: { children: React.ReactNode }) {
  const { me, can } = useAuthz();
  if (me && !can("settings", "view")) {
    return (
      <div className="p-8 flex flex-col items-center justify-center min-h-[50vh] text-center">
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-8 py-10 max-w-md">
          <h2 className="text-xl font-bold tracking-tight">Access denied</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your role does not include access to Settings. Contact an
            administrator if you believe this is a mistake.
          </p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

function RedirectToSignInPage() {
  return <Redirect to="/sign-in" />;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Welcome back to AURA",
            subtitle: "Sign in to enter the command center",
          },
        },
        signUp: {
          start: {
            title: "Join AURA",
            subtitle: "Create your dealership account",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <Switch>
            <Route path="/" component={Landing} />
            <Route path="/book-test-drive/:token" component={BookTestDrive} />
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route path="/sign-up/*?" component={SignUpPage} />
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
