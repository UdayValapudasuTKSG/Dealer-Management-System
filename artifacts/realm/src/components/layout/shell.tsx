import { ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import { useClerk, useUser } from "@clerk/react";
import { LayoutDashboard, Network, Users, FileText, LogOut, ChevronRight, Menu, X, Shield, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Overview", icon: LayoutDashboard, section: "Platform" },
  { href: "/network", label: "Dealerships", icon: Network, section: "Platform" },
  { href: "/users", label: "Users", icon: Users, section: "Administration" },
  { href: "/audit", label: "Audit Log", icon: FileText, section: "Administration" },
];

function UserCard({ collapsed = false }: { collapsed?: boolean }) {
  const { user } = useUser();
  const { signOut } = useClerk();

  const initial = (user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? "?").slice(0, 1).toUpperCase();

  const avatar = user?.hasImage ? (
    <img
      src={user.imageUrl}
      alt=""
      className="h-8 w-8 rounded-full object-cover shrink-0 grayscale"
    />
  ) : (
    <span className="h-8 w-8 rounded-full bg-zinc-800 text-zinc-100 flex items-center justify-center text-xs font-medium shrink-0">
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
    <div className="flex items-center gap-3 py-3">
      {avatar}
      <div className="flex-1 min-w-0 leading-tight">
        <div className="text-[13px] font-medium text-zinc-200 truncate">
          {user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? "Admin"}
        </div>
        <div className="text-[10px] text-zinc-500 truncate">
          Super Admin
        </div>
      </div>
      <button
        onClick={() => signOut()}
        title="Sign out"
        className="h-8 w-8 rounded hover:bg-white/5 flex items-center justify-center text-zinc-400 hover:text-zinc-200 transition-colors shrink-0"
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

  const groupedNav = navItems.reduce((acc, item) => {
    const sec = item.section || "General";
    if (!acc[sec]) acc[sec] = [];
    acc[sec].push(item);
    return acc;
  }, {} as Record<string, typeof navItems>);

  return (
    <>
      <Link
        href="/"
        className={cn(
          "flex items-center gap-3 h-[72px] shrink-0",
          collapsed ? "justify-center px-0" : "px-6"
        )}
      >
        <span className="flex h-7 w-7 items-center justify-center rounded bg-zinc-800 shrink-0">
          <Shield className="h-3.5 w-3.5 text-zinc-200" />
        </span>
        {!collapsed && (
          <div className="flex items-center gap-2 overflow-hidden">
            <span className="font-serif text-[15px] font-medium tracking-wide text-zinc-100">
              AURA Realm
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.2em] text-zinc-400">
              <Sparkles className="h-2 w-2" />
              OS
            </span>
          </div>
        )}
      </Link>

      <nav
        className={cn(
          "flex-1 min-h-0 overflow-y-auto no-scrollbar",
          collapsed ? "px-2 py-4 space-y-4" : "px-4 py-4 space-y-6"
        )}
      >
        {Object.entries(groupedNav).map(([section, items]) => (
          <div key={section} className="space-y-1">
            {!collapsed && (
              <div className="px-2 mb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
                {section}
              </div>
            )}
            {items.map((item) => {
              const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
              const ItemIcon = item.icon;
              
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  title={collapsed ? item.label : undefined}
                  className={cn(
                    "flex items-center text-[13px] transition-colors rounded-md",
                    collapsed
                      ? "justify-center h-10 w-10 mx-auto"
                      : "gap-3 px-2 py-2",
                    isActive
                      ? "bg-white text-zinc-950 font-medium"
                      : "text-zinc-400 hover:bg-white/5 hover:text-white"
                  )}
                >
                  <ItemIcon
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 transition-colors",
                      isActive ? "text-zinc-950" : "text-zinc-400"
                    )}
                  />
                  {!collapsed && (
                    <span className="whitespace-nowrap overflow-hidden">
                      {item.label}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className={cn("shrink-0 border-t border-white/5", collapsed ? "px-2 py-4" : "px-6 py-2")}>
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
    <div className="flex min-h-screen w-full text-zinc-900 relative accent-blobs">
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
        animate={{ width: collapsed ? 56 : 220 }}
        transition={{ duration: 0.2 }}
        className="relative z-30 hidden md:flex h-screen shrink-0 flex-col bg-zinc-950 text-zinc-200 sticky top-0 overflow-hidden"
      >
        <NavContent layoutId="desktop-nav" collapsed={collapsed} />
      </motion.aside>

      {/* Mobile Nav */}
      <div className="md:hidden fixed top-0 left-0 right-0 h-14 bg-white/40 backdrop-blur-xl border-b border-zinc-200 flex items-center justify-between px-4 z-40">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-zinc-900" />
          <span className="font-serif text-[15px] font-medium tracking-wide text-zinc-900">AURA Realm</span>
        </div>
        <button
          onClick={() => setMobileOpen(true)}
          className="h-8 w-8 rounded bg-zinc-100 flex items-center justify-center border border-zinc-200"
        >
          <Menu className="h-4 w-4 text-zinc-600" />
        </button>
      </div>

      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-zinc-950/20 backdrop-blur-sm md:hidden"
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              initial={{ x: -260 }}
              animate={{ x: 0 }}
              exit={{ x: -260 }}
              transition={{ type: "spring", stiffness: 320, damping: 32 }}
              className="fixed inset-y-0 left-0 z-50 flex h-full w-64 flex-col bg-zinc-950 text-zinc-200 md:hidden"
            >
              <button
                onClick={() => setMobileOpen(false)}
                className="absolute top-4 right-4 h-8 w-8 rounded flex items-center justify-center text-zinc-400 hover:text-zinc-200"
              >
                <X className="h-4 w-4" />
              </button>
              <NavContent layoutId="mobile-nav" onNavigate={() => setMobileOpen(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <main 
        className="flex-1 min-w-0 overflow-x-hidden relative z-[1] pt-14 md:pt-0"
        onClickCapture={() => {
          if (!collapsed) setHovered(false);
        }}
      >
        {children}
      </main>
    </div>
  );
}
