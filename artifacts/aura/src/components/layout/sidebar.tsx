import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  CarFront,
  Users,
  Briefcase,
  Calculator,
  Banknote,
  Wrench,
  UserCircle,
  Sparkles,
  ShieldCheck,
  FileText,
  Route as RouteIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Moon,
} from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";

type NavItem = { name: string; href: string; icon: typeof LayoutDashboard };

const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: "Intelligence",
    items: [
      { name: "Command Center", href: "/command-center", icon: LayoutDashboard },
      { name: "Journey", href: "/journey", icon: RouteIcon },
      { name: "Approvals", href: "/approvals", icon: ShieldCheck },
    ],
  },
  {
    label: "Sales",
    items: [
      { name: "Leads", href: "/leads", icon: Users },
      { name: "Deals", href: "/deals", icon: Briefcase },
      { name: "Appraisals", href: "/appraisals", icon: Calculator },
      { name: "F&I", href: "/finance", icon: Banknote },
    ],
  },
  {
    label: "Operations",
    items: [
      { name: "Inventory", href: "/inventory", icon: CarFront },
      { name: "Service", href: "/service", icon: Wrench },
    ],
  },
  {
    label: "Clients",
    items: [{ name: "Customers", href: "/customers", icon: UserCircle }],
  },
  {
    label: "Compliance",
    items: [{ name: "GRA Filing", href: "/gra", icon: FileText }],
  },
];

export function Sidebar() {
  const [location] = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const { theme, toggle } = useTheme();

  return (
    <div
      className={cn(
        "relative z-20 flex h-full flex-col bg-sidebar text-sidebar-foreground backdrop-blur-2xl border-r border-sidebar-border transition-[width] duration-300 ease-out",
        "shadow-[4px_0_32px_-16px_rgba(0,0,0,0.45)]",
        collapsed ? "w-[76px]" : "w-64",
      )}
    >
      {/* Ambient red wash at the top for depth */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-gradient-to-b from-primary/[0.07] to-transparent" />

      {/* Brand -> landing */}
      <div className="relative flex h-16 shrink-0 items-center px-4 border-b border-sidebar-border">
        <Link
          href="/"
          className={cn(
            "flex items-center gap-3 group",
            collapsed && "justify-center w-full",
          )}
          title="Back to landing"
        >
          <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 ring-1 ring-primary/25 transition-transform group-hover:scale-105">
            <Sparkles className="h-5 w-5 text-primary" />
          </span>
          {!collapsed && (
            <div className="flex flex-col leading-none">
              <span className="text-lg font-bold tracking-tight">
                AURA<span className="text-primary">.OS</span>
              </span>
              <span className="mt-1 text-[9px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
                Dealership OS
              </span>
            </div>
          )}
        </Link>
      </div>

      <div className="relative flex flex-1 flex-col overflow-y-auto overflow-x-hidden pt-4 pb-4">
        <nav className="flex-1 space-y-6 px-3">
          {navGroups.map((group) => (
            <div key={group.label} className="space-y-1">
              {collapsed ? (
                <div className="mx-3 mb-1 h-px bg-sidebar-border" />
              ) : (
                <p className="px-3 mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground/70">
                  {group.label}
                </p>
              )}
              {group.items.map((item) => {
                const isActive =
                  location === item.href || location.startsWith(item.href + "/");
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    title={collapsed ? item.name : undefined}
                    className={cn(
                      "group relative flex items-center rounded-xl px-3 py-2 text-sm font-medium transition-colors",
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
                      collapsed && "justify-center",
                    )}
                  >
                    {isActive && (
                      <motion.span
                        layoutId="nav-active-indicator"
                        transition={{ type: "spring", stiffness: 380, damping: 32 }}
                        className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-primary shadow-[0_0_12px_hsl(var(--primary))]"
                      />
                    )}
                    <item.icon
                      className={cn(
                        "h-5 w-5 shrink-0 transition-colors",
                        isActive
                          ? "text-primary"
                          : "text-muted-foreground group-hover:text-foreground",
                        !collapsed && "mr-3",
                      )}
                      aria-hidden="true"
                    />
                    {!collapsed && item.name}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="mt-4 mx-3 pt-3 space-y-1 border-t border-sidebar-border">
          <button
            onClick={toggle}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className={cn(
              "flex items-center rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground transition-colors w-full",
              collapsed && "justify-center",
            )}
          >
            {theme === "dark" ? (
              collapsed ? (
                <Sun className="h-5 w-5 shrink-0" />
              ) : (
                <>
                  <Sun className="h-5 w-5 shrink-0 mr-3" />
                  Light mode
                </>
              )
            ) : collapsed ? (
              <Moon className="h-5 w-5 shrink-0" />
            ) : (
              <>
                <Moon className="h-5 w-5 shrink-0 mr-3" />
                Dark mode
              </>
            )}
          </button>
          <button
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "Expand" : "Collapse"}
            className={cn(
              "flex items-center rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground transition-colors w-full",
              collapsed && "justify-center",
            )}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-5 w-5 shrink-0" />
            ) : (
              <>
                <PanelLeftClose className="h-5 w-5 shrink-0 mr-3" />
                Collapse
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
