import { Link, useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { Sun, Moon, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";

type NavItem = { name: string; href: string };
type Cluster = { label: string; icon: string; items: NavItem[] };

const CLUSTERS: Cluster[] = [
  {
    label: "Intelligence",
    icon: "nav/intelligence.png",
    items: [
      { name: "Command Center", href: "/command-center" },
      { name: "Journey", href: "/journey" },
      { name: "Approvals", href: "/approvals" },
    ],
  },
  {
    label: "Sales",
    icon: "nav/sales.png",
    items: [
      { name: "Pipeline", href: "/pipeline" },
      { name: "Deals", href: "/deals" },
      { name: "Appraisals", href: "/appraisals" },
      { name: "F&I", href: "/finance" },
    ],
  },
  {
    label: "Operations",
    icon: "nav/operations.png",
    items: [
      { name: "Inventory", href: "/inventory" },
      { name: "Service", href: "/service" },
    ],
  },
  {
    label: "Clients",
    icon: "nav/clients.png",
    items: [{ name: "Customers", href: "/customers" }],
  },
  {
    label: "Compliance",
    icon: "nav/compliance.png",
    items: [{ name: "GRA Filing", href: "/gra" }],
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

export function TopNav() {
  const [location, navigate] = useLocation();

  const activeCluster =
    CLUSTERS.find((c) => c.items.some((i) => isItemActive(location, i.href))) ??
    CLUSTERS[0];

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
              <Sparkles className="h-5 w-5 text-primary" />
            </span>
            <div className="hidden sm:flex flex-col leading-none">
              <span className="text-lg font-bold tracking-tight">
                AURA<span className="text-primary">.OS</span>
              </span>
              <span className="mt-1 text-[9px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
                Dealership OS
              </span>
            </div>
          </Link>

          {/* Primary clusters */}
          <nav className="flex items-center gap-1 flex-1 overflow-x-auto no-scrollbar">
            {CLUSTERS.map((cluster) => {
              const isActive = cluster.label === activeCluster.label;
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
            <ThemeToggle />
          </div>
        </div>

        {/* Secondary row — dynamic sub-sections of the active cluster */}
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
      </div>
    </header>
  );
}
