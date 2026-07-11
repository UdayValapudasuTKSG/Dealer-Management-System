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
} from "lucide-react";
import { cn } from "@/lib/utils";

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

  return (
    <div
      className={cn(
        "flex h-full flex-col bg-sidebar/90 backdrop-blur-2xl border-r border-sidebar-border transition-[width] duration-300 ease-out",
        collapsed ? "w-[76px]" : "w-64",
      )}
    >
      {/* Brand -> landing */}
      <div className="flex h-16 shrink-0 items-center px-4 border-b border-sidebar-border">
        <Link
          href="/"
          className={cn(
            "flex items-center gap-2 group",
            collapsed && "justify-center w-full",
          )}
          title="Back to landing"
        >
          <Sparkles className="h-6 w-6 text-primary shrink-0 transition-transform group-hover:scale-110" />
          {!collapsed && (
            <span className="text-lg font-bold tracking-tight">
              AURA<span className="text-primary">.OS</span>
            </span>
          )}
        </Link>
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto overflow-x-hidden pt-4 pb-4">
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
                      isActive
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
                      "group flex items-center rounded-xl px-3 py-2 text-sm font-medium transition-colors",
                      collapsed && "justify-center",
                    )}
                  >
                    <item.icon
                      className={cn(
                        isActive
                          ? "text-primary"
                          : "text-muted-foreground group-hover:text-foreground",
                        "h-5 w-5 shrink-0 transition-colors",
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

        <div className="px-3 pt-3">
          <button
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "Expand" : "Collapse"}
            className={cn(
              "flex items-center rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-white/[0.04] hover:text-foreground transition-colors w-full",
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
