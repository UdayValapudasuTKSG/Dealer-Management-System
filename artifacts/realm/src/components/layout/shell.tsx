import { ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import { useClerk, useUser } from "@clerk/react";
import { LayoutDashboard, Network, Users, FileText, LogOut, ChevronRight, Menu, X, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/network", label: "Dealerships", icon: Network },
  { href: "/users", label: "Platform Users", icon: Users },
  { href: "/audit", label: "Audit Log", icon: FileText },
];

function UserCard({ collapsed = false }: { collapsed?: boolean }) {
  const { user } = useUser();
  const { signOut } = useClerk();

  const initial = (user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? "?").slice(0, 1).toUpperCase();

  const avatar = user?.hasImage ? (
    <img
      src={user.imageUrl}
      alt=""
      className="h-9 w-9 rounded-full object-cover shrink-0 grayscale border border-white/10"
    />
  ) : (
    <span className="h-9 w-9 rounded-full bg-white/[0.08] text-white flex items-center justify-center text-sm font-bold shrink-0 border border-white/10">
      {initial}
    </span>
  );

  if (collapsed) {
    return (
      <div className="flex justify-center" title={user?.fullName ?? "Account"}>
        {avatar}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2.5 rounded-2xl bg-white/[0.03] border border-white/5 p-2.5">
      {avatar}
      <div className="flex-1 min-w-0 leading-tight">
        <div className="text-xs font-semibold text-white truncate">
          {user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? "Admin"}
        </div>
        <div className="mt-0.5 text-[9px] uppercase tracking-wider text-white/50 truncate">
          Super Admin
        </div>
      </div>
      <button
        onClick={() => signOut()}
        title="Sign out"
        aria-label="Sign out"
        className="h-9 w-9 rounded-full border border-white/5 bg-white/[0.03] hover:bg-white/[0.08] flex items-center justify-center text-white/70 hover:text-white transition-colors shrink-0"
      >
        <LogOut className="h-3.5 w-3.5" />
      </button>
    </div>
  );
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

  return (
    <>
      <Link
        href="/"
        className={cn(
          "flex items-center gap-3 h-20 shrink-0 group",
          collapsed ? "justify-center px-0" : "px-5"
        )}
      >
        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.05] ring-1 ring-white/10 transition-transform group-hover:scale-105">
          <Shield className="h-4 w-4 text-white" />
        </span>
        {!collapsed && (
          <div className="flex flex-col leading-none whitespace-nowrap overflow-hidden">
            <span className="text-lg font-serif tracking-wide text-white">
              AURA Realm
            </span>
            <span className="mt-1 text-[9px] font-medium uppercase tracking-[0.22em] text-white/40">
              Command Center
            </span>
          </div>
        )}
      </Link>

      <nav
        className={cn(
          "flex-1 min-h-0 overflow-y-auto no-scrollbar pb-4",
          collapsed ? "px-2.5 space-y-3" : "px-3 space-y-1.5"
        )}
      >
        {!collapsed && (
          <div className="px-3 mb-3 mt-2 text-[9px] font-bold uppercase tracking-[0.22em] text-white/35 whitespace-nowrap overflow-hidden">
            Administration
          </div>
        )}
        <div className="space-y-0.5">
          {navItems.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            const ItemIcon = item.icon;
            
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                title={collapsed ? item.label : undefined}
                className={cn(
                  "relative flex items-center rounded-xl text-[13px] font-medium tracking-wide transition-colors",
                  collapsed
                    ? "justify-center h-10 w-10 mx-auto"
                    : "gap-3 px-3 py-2.5",
                  isActive
                    ? "text-white"
                    : "text-white/55 hover:text-white hover:bg-white/[0.04]"
                )}
              >
                {isActive && (
                  <motion.span
                    layoutId={layoutId}
                    transition={{ type: "spring", stiffness: 380, damping: 32 }}
                    className="absolute inset-0 rounded-xl bg-white/[0.08] ring-1 ring-white/10"
                  />
                )}
                <ItemIcon
                  className={cn(
                    "relative h-4 w-4 shrink-0 transition-colors",
                    isActive ? "text-white" : "text-white/45"
                  )}
                />
                {!collapsed && (
                  <span className="relative whitespace-nowrap overflow-hidden">
                    {item.label}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </nav>

      <div className={cn("pb-4 shrink-0", collapsed ? "px-2" : "px-3")}>
        <UserCard collapsed={collapsed} />
      </div>
    </>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [hovered, setHovered] = useState(false);
  const [touchPinned, setTouchPinned] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(hover: none)").matches;
  });
  const collapsed = !hovered && !touchPinned;
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-[100dvh] bg-background flex font-sans overflow-hidden">
      {/* Desktop Sidebar */}
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
        className="relative z-30 hidden md:flex h-full shrink-0 flex-col bg-[hsl(0,0%,5%)] text-white border-r border-white/[0.06] overflow-hidden"
      >
        <NavContent layoutId="desktop-nav" collapsed={collapsed} />
      </motion.aside>

      {/* Mobile Nav */}
      <div className="md:hidden fixed top-0 left-0 right-0 h-16 bg-white/[0.03] backdrop-blur-xl border-b border-white/5 flex items-center justify-between px-4 z-40">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-foreground" />
          <span className="font-serif font-medium tracking-wide">AURA Realm</span>
        </div>
        <button
          onClick={() => setMobileOpen(true)}
          className="h-9 w-9 rounded-full bg-white/[0.05] flex items-center justify-center border border-white/10"
        >
          <Menu className="h-4 w-4" />
        </button>
      </div>

      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden"
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              initial={{ x: -260 }}
              animate={{ x: 0 }}
              exit={{ x: -260 }}
              transition={{ type: "spring", stiffness: 320, damping: 32 }}
              className="fixed inset-y-0 left-0 z-50 flex h-full w-64 flex-col bg-[hsl(0,0%,5%)] text-white border-r border-white/[0.06] md:hidden"
            >
              <button
                onClick={() => setMobileOpen(false)}
                className="absolute top-5 right-4 h-8 w-8 rounded-full bg-white/[0.06] flex items-center justify-center text-white/70"
              >
                <X className="h-4 w-4" />
              </button>
              <NavContent layoutId="mobile-nav" onNavigate={() => setMobileOpen(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <main className="flex-1 flex flex-col min-w-0 bg-background text-foreground relative z-10 pt-16 md:pt-0 h-[100dvh] overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 md:p-8">
          <div className="max-w-6xl mx-auto space-y-8 pb-12">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}

