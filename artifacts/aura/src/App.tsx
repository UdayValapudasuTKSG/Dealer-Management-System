import { useEffect, useRef, type ReactNode } from "react";
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
import { DealerTheme } from "@/components/dealer-theme";
import { AuthProvider, useAuthz } from "@/lib/auth";
import { roleHome } from "@/lib/role-home";
import { SignInPage, SignUpPage } from "@/pages/auth-pages";

import Landing from "@/pages/landing";
import BookTestDrive from "@/pages/book-test-drive";
import FeedbackRespond from "@/pages/feedback-respond";
import FeedbackForms from "@/pages/feedback-forms";
import Dashboard from "@/pages/dashboard";
import Reports from "@/pages/reports";
import Inventory from "@/pages/inventory";
import Leads from "@/pages/leads";
import Deals from "@/pages/deals";
import Finance from "@/pages/finance";
import FinanceGlCodes from "@/pages/finance-gl-codes";
import Service from "@/pages/service";
import Parts from "@/pages/parts";
import Deliveries from "@/pages/deliveries";
import CapacityPage from "@/pages/capacity";
import Customers from "@/pages/customers";
import CustomerDetail from "@/pages/customer-detail";
import LeadDetail from "@/pages/lead-detail";
import VehicleDetailPage from "@/pages/vehicle-detail";
import TeamProfile from "@/pages/team-profile";
import SettingsUsers from "@/pages/settings-users";
import SettingsEmail from "@/pages/settings-email";
import SettingsErpnext from "@/pages/settings-erpnext";
import Amber from "@/pages/amber";
import SettingsWhatsapp from "@/pages/settings-whatsapp";
import SettingsProfile from "@/pages/settings-profile";
import SettingsBranding from "@/pages/settings-branding";
import SettingsLocalization from "@/pages/settings-localization";
import SettingsRoles from "@/pages/settings-roles";
import SettingsSources from "@/pages/settings-sources";
import SettingsStages from "@/pages/settings-stages";
import SettingsTaxes from "@/pages/settings-taxes";
import SettingsAudit from "@/pages/settings-audit";
import NotFound from "@/pages/not-found";
import NoDealership from "@/pages/no-dealership";
import DealerPicker, { DealerSuspended } from "@/pages/dealer-picker";
import SettingsMeta from "@/pages/settings-meta";

/* Live data: every visible query silently re-polls the server every 10s
   (paused when the tab is hidden), plus refetches on tab focus and page
   navigation. Stale-while-revalidate keeps old data on screen until fresh
   data arrives, so updates appear without flicker or spinners. */
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
    colorPrimary: "hsl(27 44% 46%)",
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
      "bg-[hsl(0_0%_7%)] rounded-2xl w-[440px] max-w-full overflow-hidden border border-white/10 shadow-[0_30px_80px_-30px_rgba(169,113,66,0.3)]",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-white font-semibold tracking-tight",
    headerSubtitle: "text-neutral-400",
    socialButtonsBlockButtonText: "text-white",
    formFieldLabel: "text-neutral-300",
    footerActionLink: "text-gold hover:text-gold/80",
    footerActionText: "text-neutral-400",
    dividerText: "text-neutral-500",
    identityPreviewEditButton: "text-gold",
    formFieldSuccessText: "text-emerald-400",
    alertText: "text-red-300",
    logoBox: "justify-center",
    logoImage: "h-10",
    socialButtonsBlockButton:
      "bg-white/[0.04] border border-white/10 hover:bg-white/[0.08] text-white",
    formButtonPrimary:
      "bg-primary hover:bg-primary/85 text-white shadow-lg shadow-primary/25",
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

/* Dev-only persona testing: when `aura-test-user-email` is set in
   localStorage, the Clerk gate is skipped and every API call impersonates
   that seeded user (the server honors the header only outside production).
   Never active in production builds. */
const testPersonaActive =
  import.meta.env.DEV &&
  (() => {
    try {
      // URL switch: ?test-user=<email> activates a persona, ?test-user=off
      // clears it. Persisted in localStorage across navigation.
      const param = new URLSearchParams(window.location.search).get(
        "test-user",
      );
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

/* CopilotKit needs a dealer-scoped runtime; a super admin browsing the
   Platform Console without an active workspace would get 403s from the
   runtime, so skip the wrapper entirely in that state. */
function MaybeCopilot({ children }: { children: ReactNode }) {
  const { activeDealer } = useAuthz();
  if (!activeDealer) return <>{children}</>;
  return (
    <CopilotKit
      runtimeUrl={`${import.meta.env.BASE_URL}api/copilotkit`}
      headers={
        testPersonaActive
          ? {
              "x-test-user-email":
                localStorage.getItem("aura-test-user-email") ?? "",
            }
          : undefined
      }
    >
      {children}
    </CopilotKit>
  );
}

function AppShell() {
  if (testPersonaActive) {
    return (
      <AuthProvider>
        <DealerTheme />
        <DealershipGate>
          <MaybeCopilot>
            <Shell>
              <AppRoutes />
            </Shell>
          </MaybeCopilot>
        </DealershipGate>
      </AuthProvider>
    );
  }
  return (
    <>
      <Show when="signed-in">
        <AuthProvider>
          <DealerTheme />
          <DealershipGate>
          <MaybeCopilot>
            <Shell>
              <AppRoutes />
            </Shell>
          </MaybeCopilot>
          </DealershipGate>
        </AuthProvider>
      </Show>
      <Show when="signed-out">
        <RedirectToSignInPage />
      </Show>
    </>
  );
}

function AppRoutes() {
  return (
    <Switch>
                {/* Platform Console moved to the standalone AURA Realm app. */}
                <Route path="/admin">
                  <RedirectToRealm />
                </Route>
                {/* Role-aware workspace entry — each persona lands on the
                    page that matches its daily work (01-personas). */}
                <Route path="/home">
                  <RoleHomeRedirect />
                </Route>
                <Route path="/pipeline" component={Leads} />
                <Route path="/feedback-forms" component={FeedbackForms} />
                <Route path="/leads" component={Leads} />
                <Route path="/command-center" component={Dashboard} />
                <Route path="/reports" component={Reports} />
                <Route path="/inventory" component={Inventory} />
                <Route path="/deals" component={Deals} />
                <Route path="/finance/gl-codes" component={FinanceGlCodes} />
                <Route path="/finance" component={Finance} />
                <Route path="/approvals">
                  <Redirect to="/deals" />
                </Route>
                <Route path="/service">
                  <RequireModule module="service" label="Service">
                    <Service />
                  </RequireModule>
                </Route>
                <Route path="/parts">
                  <RequireModule module="parts" label="Parts">
                    <Parts />
                  </RequireModule>
                </Route>
                <Route path="/amber">
                  <RequireModule module="amber" label="Amber Connect">
                    <Amber />
                  </RequireModule>
                </Route>
                {/* Workshop is merged into Service as the "My Jobs" tab (2026-07) */}
                <Route path="/workshop">
                  <Redirect to="/service" />
                </Route>
                <Route path="/deliveries" component={Deliveries} />
                <Route path="/capacity">
        <RequireModule module="capacity" label="Capacity">
          <CapacityPage />
        </RequireModule>
      </Route>
                <Route path="/customers" component={Customers} />
                <Route path="/customers/:id" component={CustomerDetail} />
                <Route path="/lead/:id" component={LeadDetail} />
                <Route path="/vehicle/:id" component={VehicleDetailPage} />
                <Route path="/team/:id" component={TeamProfile} />
                {/* Calendar is merged into My Day (2026-07) */}
                <Route path="/calendar">
                  <Redirect to="/command-center" />
                </Route>
                {/* GRA duty filing lives in the pipeline (lead workbench) and
                    delivery workflow now — no standalone page (2026-07) */}
                <Route path="/gra">
                  <Redirect to="/pipeline" />
                </Route>
                <Route path="/settings/profile">
                  <SettingsProfile />
                </Route>
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
                <Route path="/settings/sources">
                  <RequireSettings>
                    <SettingsSources />
                  </RequireSettings>
                </Route>
                <Route path="/settings/stages">
                  <RequireSettings>
                    <SettingsStages />
                  </RequireSettings>
                </Route>
                <Route path="/settings/taxes">
                  <RequireSettings>
                    <SettingsTaxes />
                  </RequireSettings>
                </Route>
                <Route path="/settings/audit">
                  <RequireSettings>
                    <SettingsAudit />
                  </RequireSettings>
                </Route>
                <Route path="/settings/branding">
                  <RequireSettings>
                    <SettingsBranding />
                  </RequireSettings>
                </Route>
                <Route path="/settings/localization">
                  <RequireSettings>
                    <SettingsLocalization />
                  </RequireSettings>
                </Route>
                <Route path="/settings/email">
                  <RequireSettings>
                    <SettingsEmail />
                  </RequireSettings>
                </Route>
                <Route path="/settings/erpnext">
                  <RequireSettings>
                    <SettingsErpnext />
                  </RequireSettings>
                </Route>
                <Route path="/settings/meta">
                  <RequireSettings>
                    <SettingsMeta />
                  </RequireSettings>
                </Route>
                <Route path="/settings/whatsapp">
                  <RequireSettings>
                    <SettingsWhatsapp />
                  </RequireSettings>
                </Route>
                <Route path="/settings">
                  <Redirect to="/settings/profile" replace />
                </Route>
                <Route component={NotFound} />
              </Switch>
  );
}

// Signed-in users without any dealership membership see a dedicated screen
// (the first-user-becomes-GM rule is retired). Multi-dealership users with
// no bound workspace pick one explicitly (never silently auto-bound), and a
// suspended dealership freezes the workspace. Super admins with no active
// impersonation land on the Platform Console.
function DealershipGate({ children }: { children: React.ReactNode }) {
  const { me, isLoading, dealers, activeDealer } = useAuthz();
  if (isLoading || !me) return <>{children}</>;
  if (me.isSuperAdmin) {
    // No bound workspace → the Platform Console (AURA Realm) is the only
    // meaningful destination. It is a separate artifact at /realm/, so this
    // is a full-page navigation, not a wouter redirect.
    if (me.activeDealerId == null) {
      return <RedirectToRealm />;
    }
    return <>{children}</>;
  }
  if (me.activeDealerId == null) {
    if (dealers.length === 0) return <NoDealership />;
    return <DealerPicker />;
  }
  if (activeDealer?.dealerStatus === "suspended") {
    return <DealerSuspended dealerName={activeDealer.dealerName} />;
  }
  return <>{children}</>;
}

/** Redirects to the signed-in user's role landing page (01-personas).
    Super admins land on the Platform Console — a separate artifact at
    /realm/, so that case is a full-page navigation, not a wouter redirect. */
function RoleHomeRedirect() {
  const { me, isLoading } = useAuthz();
  if (isLoading || !me) return null;
  const home = roleHome(me.roleName, me.isSuperAdmin);
  if (home.startsWith("/realm")) return <RedirectToRealm />;
  return <Redirect to={home} replace />;
}

/** Full-page navigation to the standalone AURA Realm artifact at /realm/. */
function RedirectToRealm() {
  useEffect(() => {
    window.location.replace("/realm/");
  }, []);
  return null;
}

function RequireModule({
  module,
  label,
  children,
}: {
  module: string;
  label: string;
  children: React.ReactNode;
}) {
  const { me, can } = useAuthz();
  if (me && !can(module, "view")) {
    return (
      <div className="p-8 flex flex-col items-center justify-center min-h-[50vh] text-center">
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-8 py-10 max-w-md">
          <h2 className="text-xl font-bold tracking-tight">
            You are not authorized to see this page
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your role does not include access to {label}. Contact an
            administrator if you believe this is a mistake.
          </p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

function RequireSettings({ children }: { children: React.ReactNode }) {
  return (
    <RequireModule module="settings" label="Settings">
      {children}
    </RequireModule>
  );
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
            subtitle: "Sign in to start your day",
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
            <Route path="/feedback/:token" component={FeedbackRespond} />
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
