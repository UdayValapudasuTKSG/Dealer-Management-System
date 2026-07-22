import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useClerk } from "@clerk/react";
import { LayoutDashboard, Network, Users, FileText, LogOut, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

const navItems = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/network", label: "Dealerships", icon: Network },
  { href: "/users", label: "Platform Users", icon: Users },
  { href: "/audit", label: "Audit Log", icon: FileText },
];

export function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { signOut } = useClerk();

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row font-sans">
      <aside className="w-full md:w-64 border-b md:border-b-0 md:border-r border-sidebar-border bg-sidebar flex flex-col">
        <div className="p-6 flex items-center gap-3 border-b border-sidebar-border">
          <div className="w-8 h-8 bg-white text-black flex items-center justify-center shrink-0">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </div>
          <div className="flex flex-col min-w-0">
            <span className="font-serif text-sidebar-foreground text-lg truncate leading-none">AURA Realm</span>
            <span className="text-[10px] uppercase tracking-[0.2em] text-sidebar-foreground/60 mt-1">Command</span>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href}>
                <span className={`flex items-center gap-3 px-3 py-2.5 text-sm transition-all group cursor-pointer ${
                  isActive 
                    ? "bg-white text-black font-medium" 
                    : "text-sidebar-foreground/70 hover:bg-white/10 hover:text-white"
                }`}>
                  <item.icon className={`w-4 h-4 ${isActive ? "text-black" : "text-sidebar-foreground/70 group-hover:text-white"}`} />
                  <span className="tracking-wide">{item.label}</span>
                  {isActive && <ChevronRight className="w-4 h-4 ml-auto opacity-50" />}
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-sidebar-border">
          <Button 
            variant="ghost" 
            className="w-full justify-start text-sidebar-foreground/70 hover:text-white hover:bg-white/10 rounded-none tracking-wide"
            onClick={() => signOut()}
          >
            <LogOut className="w-4 h-4 mr-3" />
            Sign Out
          </Button>
        </div>
      </aside>
      
      <main className="flex-1 flex flex-col min-w-0 bg-background text-foreground">
        <div className="flex-1 overflow-y-auto p-4 md:p-8">
          <div className="max-w-6xl mx-auto space-y-8">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
