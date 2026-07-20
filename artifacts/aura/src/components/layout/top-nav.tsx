import { useState } from "react";
import { Link, useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sun,
  Moon,
  Sparkles,
  LogOut,
  Settings,
  Building2,
  Check,
  ChevronsUpDown,
} from "lucide-react";
import { useClerk } from "@clerk/react";
import { recordLogoutEvent } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";
import { useAuthz } from "@/lib/auth";
import { NotificationBell } from "@/components/notification-bell";
import { GlobalSearchButton } from "@/components/global-search";

type NavItem = { name: string; href: string; module: string };
type Cluster = { label: string; icon: string; items: NavItem[] };

const CLUSTERS: Cluster[] = [
  {
    label: "Insights & Actions",
    icon: "nav/intelligence.png",
    items: [
      { name: "Command Center", href: "/command-center", module: "" },
      // Shelved for now (page + route kept):
      // { name: "Journey", href: "/journey", module: "dashboard" },
      { name: "Reports", href: "/reports", module: "" },
      { name: "Reviews", href: "/approvals", module: "approvals" },
      { name: "Tasks", href: "/tasks", module: "" },
    ],
  },
  {
    label: "Sales",
    icon: "nav/sales.png",
    items: [
      { name: "Pipeline", href: "/pipeline", module: "leads" },
      // Shelved for now (page + route kept):
      // { name: "Deals", href: "/deals", module: "deals" },
      { name: "Finance", href: "/finance", module: "finance" },
    ],
  },
  {
    label: "Operations",
    icon: "nav/operations.png",
    items: [
      { name: "Inventory", href: "/inventory", module: "inventory" },
      { name: "Deliveries", href: "/deliveries", module: "deliveries" },
      { name: "Service", href: "/service", module: "service" },
      { name: "Parts", href: "/parts", module: "parts" },
      { name: "Workshop", href: "/workshop", module: "service" },
    ],
  },
  {
    label: "Accounts",
    icon: "nav/clients.png",
    items: [{ name: "Accounts", href: "/customers", module: "customers" }],
  },
  {
    label: "Compliance",
    icon: "nav/compliance.png",
    items: [{ name: "GRA Filing", href: "/gra", module: "gra" }],
  },
  {
    label: "Settings",
    icon: "",
    items: [
      { name: "Users", href: "/settings/users", module: "settings" },
      { name: "Roles & Permissions", href: "/settings/roles", module: "settings" },
      { name: "Audit Logs", href: "/settings/audit", module: "settings" },
      { name: "Email Engine", href: "/settings/email", module: "settings" },
    ],
  },
];

const withBase = (path: string) => `${import.meta.env.BASE_URL}${path}`;

const isItemActive = (location: string, href: string) =>
  location === href || location.startsWith(href + "/");

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle theme"
      className="relative h-10 w-10 rounded-full border border-white/10 bg-foreground/[0.04] hover:bg-foreground/[0.08] flex items-center justify-center overflow-hidden transition-colors group"
    >
      <span className="pointer-events-none absolute inset-0 rounded-full bg-primary/0 group-hover:bg-primary/10 transition-colors" />
      <AnimatePresence mode="wait" initial={false}>
        {theme === "dark" ? (
          <motion.span
            key="sun"
            initial={{ y: 14, opacity: 0, rotate: -90 }}
            animate={{ y: 0, opacity: 1, rotate: 0 }}
            exit={{ y: -14, opacity: 0, rotate: 90 }}
            transition={{ duration: 0.25 }}
            className="relative text-amber-300"
          >
            <Sun className="h-[18px] w-[18px]" />
          </motion.span>
        ) : (
          <motion.span
            key="moon"
            initial={{ y: 14, opacity: 0, rotate: -90 }}
            animate={{ y: 0, opacity: 1, rotate: 0 }}
            exit={{ y: -14, opacity: 0, rotate: 90 }}
            transition={{ duration: 0.25 }}
            className="relative text-primary"
          >
            <Moon className="h-[18px] w-[18px]" />
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}

function DealerSwitcher() {
  const { me, dealers, activeDealer, switchDealer } = useAuthz();
  const [open, setOpen] = useState(false);

  if (!me || dealers.length === 0) return null;

  if (dealers.length === 1) {
    return (
      <div className="hidden sm:flex items-center gap-2 rounded-full border border-white/10 bg-foreground/[0.04] px-3 py-1.5">
        <Building2 className="h-4 w-4 text-primary" />
        <span className="text-xs font-semibold max-w-[140px] truncate">
          {dealers[0].dealerName}
        </span>
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-white/10 bg-foreground/[0.04] hover:bg-foreground/[0.08] px-3 py-1.5 transition-colors"
        aria-label="Switch dealership"
      >
        <Building2 className="h-4 w-4 text-primary" />
        <span className="hidden sm:inline text-xs font-semibold max-w-[140px] truncate">
          {activeDealer?.dealerName ?? "Select dealership"}
        </span>
        <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15 }}
              className="absolute right-0 top-full z-50 mt-2 w-64 rounded-xl border border-white/10 bg-popover shadow-2xl p-1.5"
            >
              <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                Dealerships
              </div>
              {dealers.map((d) => {
                const active = d.dealerId === activeDealer?.dealerId;
                return (
                  <button
                    key={d.dealerId}
                    onClick={() => {
                      setOpen(false);
                      if (!active) switchDealer(d.dealerId);
                    }}
                    className={cn(
                      "w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
                      active
                        ? "bg-primary/10 text-foreground"
                        : "hover:bg-foreground/[0.05] text-muted-foreground",
                    )}
                  >
                    <Building2 className="h-4 w-4 shrink-0 text-primary/70" />
                    <span className="flex-1 text-left truncate">
                      {d.dealerName}
                    </span>
                    {d.roleName && (
                      <span className="text-[9px] uppercase tracking-wider text-muted-foreground shrink-0">
                        {d.roleName}
                      </span>
                    )}
                    {active && <Check className="h-4 w-4 text-primary shrink-0" />}
                  </button>
                );
              })}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function UserMenu() {
  const { me } = useAuthz();
  const { signOut } = useClerk();
  const [open, setOpen] = useState(false);

  const handleSignOut = async () => {
    try {
      await recordLogoutEvent();
    } catch {
      // best-effort audit; never block sign-out
    }
    await signOut({ redirectUrl: import.meta.env.BASE_URL || "/" });
  };

  const initial = (me?.name ?? me?.email ?? "?").slice(0, 1).toUpperCase();

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-white/10 bg-foreground/[0.04] hover:bg-foreground/[0.08] pl-1.5 pr-3 py-1.5 transition-colors"
        aria-label="Account menu"
      >
        {me?.imageUrl ? (
          <img src={me.imageUrl} alt="" className="h-7 w-7 rounded-full object-cover" />
        ) : (
          <span className="h-7 w-7 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold">
            {initial}
          </span>
        )}
        <span className="hidden md:flex flex-col items-start leading-none">
          <span className="text-xs font-semibold max-w-[120px] truncate">
            {me?.name ?? me?.email ?? "Account"}
          </span>
          {me?.roleName && (
            <span className="mt-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
              {me.roleName}
            </span>
          )}
        </span>
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15 }}
              className="absolute right-0 top-full z-50 mt-2 w-56 rounded-xl border border-white/10 bg-popover shadow-2xl p-1.5"
            >
              <div className="px-3 py-2 border-b border-white/[0.06] mb-1">
                <div className="text-sm font-medium truncate">{me?.name ?? "—"}</div>
                <div className="text-xs text-muted-foreground truncate">{me?.email ?? ""}</div>
              </div>
              <button
                onClick={handleSignOut}
                className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-400 hover:bg-foreground/[0.05] transition-colors"
              >
                <LogOut className="h-4 w-4" /> Sign out
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

export function TopNav() {
  const [location, navigate] = useLocation();
  const { can, me } = useAuthz();

  const clusters = CLUSTERS.map((c) => ({
    ...c,
    items: c.items.filter((i) => !i.module || can(i.module, "view")),
  })).filter((c) => c.items.length > 0);

  if (me?.isSuperAdmin) {
    clusters.push({
      label: "Admin",
      icon: "",
      items: [{ name: "Platform Admin", href: "/admin", module: "" }],
    });
  }

  const activeCluster =
    clusters.find((c) => c.items.some((i) => isItemActive(location, i.href))) ??
    clusters[0];

  return (
    <header className="relative z-30 shrink-0">
      {/* Layered glass bar with elevation */}
      <div className="relative bg-background/80 backdrop-blur-2xl border-b border-white/10 shadow-[0_18px_40px_-24px_rgba(0,0,0,0.6)]">
        {/* Ambient red wash for depth */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-full bg-gradient-to-b from-primary/[0.06] via-transparent to-transparent" />

        {/* Primary row */}
        <div className="relative flex h-16 items-center gap-6 px-5 md:px-8">
          {/* Brand -> landing */}
          <Link
            href="/"
            className="flex items-center gap-3 group shrink-0"
            title="Back to landing"
          >
            <span className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 ring-1 ring-primary/25 transition-transform group-hover:scale-105">
              <Sparkles className="h-5 w-5 text-primary drop-shadow-[0_0_8px_rgba(197,106,66,0.5)]" />
            </span>
            <div className="hidden sm:flex flex-col leading-none">
              <span className="text-lg font-bold tracking-tight">
                AURA<span className="text-primary drop-shadow-[0_0_8px_rgba(197,106,66,0.3)]">.OS</span>
              </span>
              <span className="mt-1 text-[9px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
                Dealership OS
              </span>
            </div>
          </Link>

          {/* Primary clusters */}
          <nav className="flex items-center gap-1 flex-1 overflow-x-auto no-scrollbar">
            {clusters.map((cluster) => {
              const isActive = cluster.label === activeCluster?.label;
              return (
                <button
                  key={cluster.label}
                  onClick={() => navigate(cluster.items[0].href)}
                  className={cn(
                    "relative flex items-center gap-2.5 rounded-2xl px-3.5 py-2 transition-colors shrink-0",
                    isActive
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {isActive && (
                    <motion.span
                      layoutId="cluster-active"
                      transition={{ type: "spring", stiffness: 380, damping: 32 }}
                      className="absolute inset-0 rounded-2xl bg-foreground/[0.06] ring-1 ring-white/10 shadow-sm"
                    />
                  )}
                  <span
                    className={cn(
                      "relative flex h-8 w-8 items-center justify-center rounded-xl overflow-hidden transition-all",
                      isActive
                        ? "ring-1 ring-primary/40 bg-primary/10 shadow-[0_0_16px_-4px_hsl(var(--primary))]"
                        : "bg-foreground/[0.04]",
                    )}
                  >
                    {cluster.icon ? (
                      <img
                        src={withBase(cluster.icon)}
                        alt=""
                        aria-hidden="true"
                        className={cn(
                          "h-6 w-6 object-contain transition-all duration-300",
                          isActive
                            ? "opacity-100 scale-100"
                            : "opacity-60 grayscale group-hover:opacity-90",
                        )}
                      />
                    ) : (
                      <Settings
                        aria-hidden="true"
                        className={cn(
                          "h-5 w-5 transition-all duration-300",
                          isActive ? "text-primary" : "text-muted-foreground",
                        )}
                      />
                    )}
                  </span>
                  <span className="relative hidden md:inline text-sm font-medium tracking-tight">
                    {cluster.label}
                  </span>
                </button>
              );
            })}
          </nav>

          {/* Right rail */}
          <div className="flex items-center gap-2 shrink-0">
            <DealerSwitcher />
            <GlobalSearchButton />
            <NotificationBell />
            <ThemeToggle />
            <UserMenu />
          </div>
        </div>

        {/* Secondary row — dynamic sub-sections of the active cluster */}
        {activeCluster && (
        <div className="relative border-t border-white/[0.06]">
          <div className="px-5 md:px-8">
            <AnimatePresence mode="wait">
              <motion.nav
                key={activeCluster.label}
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.22 }}
                className="flex items-center gap-1 h-12 overflow-x-auto no-scrollbar"
              >
                <span className="hidden lg:inline text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60 mr-3 shrink-0">
                  {activeCluster.label}
                </span>
                {activeCluster.items.map((item) => {
                  const active = isItemActive(location, item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        "relative rounded-full px-4 py-1.5 text-sm font-medium transition-colors shrink-0",
                        active
                          ? "text-white"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {active && (
                        <motion.span
                          layoutId="subnav-active"
                          transition={{
                            type: "spring",
                            stiffness: 400,
                            damping: 34,
                          }}
                          className="absolute inset-0 rounded-full bg-primary shadow-lg shadow-primary/30 -z-0"
                        />
                      )}
                      <span className="relative z-10">{item.name}</span>
                    </Link>
                  );
                })}
              </motion.nav>
            </AnimatePresence>
          </div>
        </div>
        )}
      </div>
    </header>
  );
}
