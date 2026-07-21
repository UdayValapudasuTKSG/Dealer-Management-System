import { useState } from "react";
import { Link, useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sun,
  Moon,
  Sparkles,
  LogOut,
  Building2,
  Check,
  ChevronsUpDown,
  Menu,
  X,
  LayoutDashboard,
  BarChart3,
  ClipboardCheck,
  ListChecks,
  CalendarDays,
  Waypoints,
  Landmark,
  Car,
  Truck,
  Wrench,
  Package,
  Factory,
  Users,
  Stamp,
  UserCog,
  ShieldCheck,
  ScrollText,
  Mail,
  Megaphone,
  Percent,
  Shield,
  Bot,
  type LucideIcon,
} from "lucide-react";
import { useClerk } from "@clerk/react";
import { recordLogoutEvent } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";
import { useAuthz } from "@/lib/auth";

type NavItem = { name: string; href: string; module: string; icon: LucideIcon };
type Cluster = { label: string; items: NavItem[] };

const CLUSTERS: Cluster[] = [
  {
    label: "Insights & Actions",
    items: [
      { name: "Daily Briefing", href: "/command-center", module: "", icon: LayoutDashboard },
      { name: "Reports", href: "/reports", module: "", icon: BarChart3 },
      { name: "Reviews", href: "/approvals", module: "approvals", icon: ClipboardCheck },
      { name: "Tasks", href: "/tasks", module: "", icon: ListChecks },
      { name: "Calendar", href: "/calendar", module: "", icon: CalendarDays },
      { name: "AI Agents", href: "/agents", module: "", icon: Bot },
    ],
  },
  {
    label: "Sales",
    items: [
      { name: "Pipeline", href: "/pipeline", module: "leads", icon: Waypoints },
      { name: "Finance", href: "/finance", module: "finance", icon: Landmark },
    ],
  },
  {
    label: "Operations",
    items: [
      { name: "Inventory", href: "/inventory", module: "inventory", icon: Car },
      { name: "Deliveries", href: "/deliveries", module: "deliveries", icon: Truck },
      { name: "Service", href: "/service", module: "service", icon: Wrench },
      { name: "Parts", href: "/parts", module: "parts", icon: Package },
      { name: "Workshop", href: "/workshop", module: "service", icon: Factory },
    ],
  },
  {
    label: "Accounts",
    items: [{ name: "Accounts", href: "/customers", module: "customers", icon: Users }],
  },
  {
    label: "Compliance",
    items: [{ name: "GRA Filing", href: "/gra", module: "gra", icon: Stamp }],
  },
  {
    label: "Settings",
    items: [
      { name: "Users", href: "/settings/users", module: "settings", icon: UserCog },
      { name: "Roles & Permissions", href: "/settings/roles", module: "settings", icon: ShieldCheck },
      { name: "Lead Sources", href: "/settings/sources", module: "settings", icon: Megaphone },
      { name: "Stage Checklists", href: "/settings/stages", module: "settings", icon: ListChecks },
      { name: "Taxes", href: "/settings/taxes", module: "settings", icon: Percent },
      { name: "Audit Logs", href: "/settings/audit", module: "settings", icon: ScrollText },
      { name: "Email Engine", href: "/settings/email", module: "settings", icon: Mail },
    ],
  },
];

const isItemActive = (location: string, href: string) =>
  location === href || location.startsWith(href + "/");

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle theme"
      className="relative h-9 w-9 rounded-full border border-white/10 bg-white/[0.05] hover:bg-white/[0.1] flex items-center justify-center overflow-hidden transition-colors"
    >
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
            <Sun className="h-4 w-4" />
          </motion.span>
        ) : (
          <motion.span
            key="moon"
            initial={{ y: 14, opacity: 0, rotate: -90 }}
            animate={{ y: 0, opacity: 1, rotate: 0 }}
            exit={{ y: -14, opacity: 0, rotate: 90 }}
            transition={{ duration: 0.25 }}
            className="relative text-gold"
          >
            <Moon className="h-4 w-4" />
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}

export function DealerSwitcher() {
  const { me, dealers, activeDealer, switchDealer } = useAuthz();
  const [open, setOpen] = useState(false);

  if (!me || dealers.length === 0) return null;

  if (dealers.length === 1) {
    return (
      <div className="hidden sm:flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5">
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
        className="flex items-center gap-2 rounded-full border border-border bg-card hover:bg-foreground/[0.05] px-3 py-1.5 transition-colors"
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
              className="absolute right-0 top-full z-50 mt-2 w-64 rounded-xl border border-popover-border bg-popover shadow-2xl p-1.5"
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

function UserCard({ collapsed = false }: { collapsed?: boolean }) {
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

  const initial = (me?.name ?? me?.email ?? "?").slice(0, 1).toUpperCase();

  const avatar = me?.imageUrl ? (
    <img
      src={me.imageUrl}
      alt=""
      className="h-9 w-9 rounded-full object-cover shrink-0"
    />
  ) : (
    <span className="h-9 w-9 rounded-full bg-primary/25 text-gold flex items-center justify-center text-sm font-bold shrink-0">
      {initial}
    </span>
  );

  if (collapsed) {
    return (
      <div
        className="flex justify-center"
        title={me?.name ?? me?.email ?? "Account"}
      >
        {avatar}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2.5 rounded-2xl bg-white/[0.05] border border-white/10 p-2.5">
      {avatar}
      <div className="flex-1 min-w-0 leading-tight">
        <div className="text-xs font-semibold text-white truncate">
          {me?.name ?? me?.email ?? "Account"}
        </div>
        {me?.roleName && (
          <div className="mt-0.5 text-[9px] uppercase tracking-wider text-white/50 truncate">
            {me.roleName}
          </div>
        )}
      </div>
      <ThemeToggle />
      <button
        onClick={handleSignOut}
        title="Sign out"
        aria-label="Sign out"
        className="h-9 w-9 rounded-full border border-white/10 bg-white/[0.05] hover:bg-white/[0.1] flex items-center justify-center text-red-400 transition-colors shrink-0"
      >
        <LogOut className="h-4 w-4" />
      </button>
    </div>
  );
}

function useNavClusters() {
  const { can, me } = useAuthz();

  const clusters = CLUSTERS.map((c) => ({
    ...c,
    items: c.items.filter((i) => !i.module || can(i.module, "view")),
  })).filter((c) => c.items.length > 0);

  if (me?.isSuperAdmin) {
    clusters.push({
      label: "Admin",
      items: [{ name: "Platform Admin", href: "/admin", module: "", icon: Shield }],
    });
  }

  return clusters;
}

function NavContent({
  layoutId,
  onNavigate,
  collapsed = false,
}: {
  layoutId: string;
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  const [location] = useLocation();
  const clusters = useNavClusters();

  return (
    <>
      {/* Brand */}
      <Link
        href="/"
        title="Back to landing"
        className={cn(
          "flex items-center gap-3 h-20 shrink-0 group",
          collapsed ? "justify-center px-0" : "px-5",
        )}
      >
        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/20 ring-1 ring-primary/30 transition-transform group-hover:scale-105">
          <Sparkles className="h-5 w-5 text-gold" />
        </span>
        {!collapsed && (
          <div className="flex flex-col leading-none whitespace-nowrap overflow-hidden">
            <span className="text-lg font-bold tracking-tight text-white">
              AURA<span className="text-gold">.OS</span>
            </span>
            <span className="mt-1 text-[9px] font-medium uppercase tracking-[0.22em] text-white/40">
              Dealership OS
            </span>
          </div>
        )}
      </Link>

      {/* Nav sections */}
      <nav
        className={cn(
          "flex-1 min-h-0 overflow-y-auto no-scrollbar pb-4",
          collapsed ? "px-2.5 space-y-3" : "px-3 space-y-5",
        )}
      >
        {clusters.map((cluster, ci) => (
          <div key={cluster.label}>
            {collapsed ? (
              ci > 0 && <div className="mx-2 mb-3 h-px bg-white/[0.08]" />
            ) : (
              <div className="px-3 mb-1.5 text-[9px] font-bold uppercase tracking-[0.22em] text-white/35 whitespace-nowrap overflow-hidden">
                {cluster.label}
              </div>
            )}
            <div className="space-y-0.5">
              {cluster.items.map((item) => {
                const active = isItemActive(location, item.href);
                const ItemIcon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavigate}
                    title={collapsed ? item.name : undefined}
                    aria-label={item.name}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative flex items-center rounded-xl text-[13px] font-medium tracking-wide transition-colors",
                      collapsed
                        ? "justify-center h-10 w-10 mx-auto"
                        : "gap-2.5 px-3 py-2",
                      active
                        ? "text-white"
                        : "text-white/55 hover:text-white hover:bg-white/[0.04]",
                    )}
                  >
                    {active && (
                      <motion.span
                        layoutId={layoutId}
                        transition={{ type: "spring", stiffness: 380, damping: 32 }}
                        className="absolute inset-0 rounded-xl bg-white/[0.08] ring-1 ring-white/10"
                      />
                    )}
                    <ItemIcon
                      className={cn(
                        "relative h-4 w-4 shrink-0 transition-colors",
                        active ? "text-gold" : "text-white/45",
                      )}
                    />
                    {!collapsed && (
                      <span className="relative whitespace-nowrap overflow-hidden">
                        {item.name}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* User card */}
      <div className={cn("pb-4 shrink-0", collapsed ? "px-2" : "px-3")}>
        <UserCard collapsed={collapsed} />
      </div>
    </>
  );
}

/**
 * NL-Corp-style dark left sidebar — stays dark in BOTH themes.
 * Auto-collapses to an icon rail; expands on hover.
 */
export function SideNav() {
  const [hovered, setHovered] = useState(false);
  const [touchPinned, setTouchPinned] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(hover: none)").matches;
  });
  const collapsed = !hovered && !touchPinned;

  return (
    <motion.aside
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setHovered(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setHovered(false);
        }
      }}
      onTouchStart={() => setTouchPinned(true)}
      animate={{ width: collapsed ? 68 : 240 }}
      transition={{ type: "spring", stiffness: 320, damping: 34 }}
      className="relative z-30 hidden md:flex h-full shrink-0 flex-col bg-[hsl(216,22%,6%)] text-white border-r border-white/[0.06] overflow-hidden"
    >
      <NavContent layoutId="sidenav-active" collapsed={collapsed} />
    </motion.aside>
  );
}

/** Mobile hamburger + off-canvas drawer with the same nav content (below `md`). */
export function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <div className="md:hidden">
      <button
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        className="h-9 w-9 rounded-full border border-border bg-card flex items-center justify-center text-foreground"
      >
        <Menu className="h-4 w-4" />
      </button>
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
              onClick={() => setOpen(false)}
            />
            <motion.aside
              initial={{ x: -260 }}
              animate={{ x: 0 }}
              exit={{ x: -260 }}
              transition={{ type: "spring", stiffness: 320, damping: 32 }}
              className="fixed inset-y-0 left-0 z-50 flex h-full w-64 flex-col bg-[hsl(216,22%,6%)] text-white border-r border-white/[0.06]"
            >
              <button
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
                className="absolute top-5 right-4 h-8 w-8 rounded-full bg-white/[0.06] hover:bg-white/[0.12] flex items-center justify-center text-white/70"
              >
                <X className="h-4 w-4" />
              </button>
              <NavContent
                layoutId="mobilenav-active"
                onNavigate={() => setOpen(false)}
              />
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
