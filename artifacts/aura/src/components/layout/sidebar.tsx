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
  Route as RouteIcon 
} from "lucide-react";
import { cn } from "@/lib/utils";

const navigation = [
  { name: "Command Center", href: "/", icon: LayoutDashboard },
  { name: "Journey", href: "/journey", icon: RouteIcon },
  { name: "Approvals", href: "/approvals", icon: ShieldCheck },
  { name: "Inventory", href: "/inventory", icon: CarFront },
  { name: "Leads", href: "/leads", icon: Users },
  { name: "Deals", href: "/deals", icon: Briefcase },
  { name: "Appraisals", href: "/appraisals", icon: Calculator },
  { name: "Finance", href: "/finance", icon: Banknote },
  { name: "Service", href: "/service", icon: Wrench },
  { name: "Customers", href: "/customers", icon: UserCircle },
  { name: "Concierge", href: "/assistant", icon: Sparkles },
];

export function Sidebar() {
  const [location] = useLocation();

  return (
    <div className="flex h-full w-64 flex-col bg-white border-r border-border">
      <div className="flex h-16 shrink-0 items-center px-6 border-b border-border">
        <div className="flex items-center gap-2">
          <Sparkles className="h-6 w-6 text-primary" />
          <span className="text-lg font-bold tracking-tight font-sans">AURA<span className="text-primary">.OS</span></span>
        </div>
      </div>
      <div className="flex flex-1 flex-col overflow-y-auto pt-4 pb-4">
        <nav className="flex-1 space-y-1 px-3">
          {navigation.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link
                key={item.name}
                href={item.href}
                className={cn(
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
                  "group flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors"
                )}
              >
                <item.icon
                  className={cn(
                    isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                    "mr-3 h-5 w-5 shrink-0 transition-colors"
                  )}
                  aria-hidden="true"
                />
                {item.name}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}