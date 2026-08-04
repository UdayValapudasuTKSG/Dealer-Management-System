import { Link, useLocation } from "wouter";
import {
  UserCog,
  ShieldCheck,
  Megaphone,
  ListChecks,
  Percent,
  ScrollText,
  Mail,
  Paintbrush,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthz } from "@/lib/auth";

export type SettingsSection = {
  name: string;
  href: string;
  icon: LucideIcon;
  description: string;
  /** RBAC module gating this section (mirrors the old sidebar gating). */
  module: string;
  /** Restricted to the active dealership's general manager. */
  gmOnly?: boolean;
};

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    name: "Users",
    href: "/settings/users",
    icon: UserCog,
    description: "Team members, roles, reporting lines and account access.",
    module: "settings",
  },
  {
    name: "Roles & Permissions",
    href: "/settings/roles",
    icon: ShieldCheck,
    description: "Role definitions, module access and field-level permissions.",
    module: "settings",
  },
  {
    name: "Lead Sources",
    href: "/settings/sources",
    icon: Megaphone,
    description: "Configure where enquiries come from and how they are tracked.",
    module: "settings",
  },
  {
    name: "Stage Checklists",
    href: "/settings/stages",
    icon: ListChecks,
    description: "Versioned requirement checklists that gate pipeline advances.",
    module: "settings",
  },
  {
    name: "Taxes",
    href: "/settings/taxes",
    icon: Percent,
    description: "Percentage and fixed tax rules applied to vehicle pricing.",
    module: "settings",
  },
  {
    name: "Audit Logs",
    href: "/settings/audit",
    icon: ScrollText,
    description: "A trail of who changed what, across the whole dealership.",
    module: "settings",
  },
  {
    name: "Branding",
    href: "/settings/branding",
    icon: Paintbrush,
    description: "White-label the app and printed documents with your logo and name.",
    module: "settings",
    gmOnly: true,
  },
  {
    name: "Email Engine",
    href: "/settings/email",
    icon: Mail,
    description: "Lifecycle email templates, sending status and delivery logs.",
    module: "settings",
  },
];

/** Sections the current user's role can see (mirrors sidebar gating). */
export function useSettingsSections(): SettingsSection[] {
  const { can, activeDealer, me } = useAuthz();
  const isGm = !!activeDealer?.isGeneralManager || !!me?.isSuperAdmin;
  return SETTINGS_SECTIONS.filter(
    (s) => (!s.module || can(s.module, "view")) && (!s.gmOnly || isGm),
  );
}

/**
 * Horizontal pill tab bar rendered on every /settings/* section page so
 * users can jump between sections without returning to the hub. Matches
 * the filter-pill styling used on Inventory.
 */
export function SettingsTabs() {
  const [location] = useLocation();
  const sections = useSettingsSections();

  if (sections.length === 0) return null;

  return (
    <div className="w-full px-5 md:px-8 pb-5">
      <div className="inline-flex max-w-full items-center gap-1 overflow-x-auto no-scrollbar rounded-full border border-border bg-card p-1">
        {sections.map((s) => {
          const active =
            location === s.href || location.startsWith(s.href + "/");
          const Icon = s.icon;
          return (
            <Link
              key={s.href}
              href={s.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 px-3 h-8 rounded-full text-xs font-semibold tracking-wide transition-colors whitespace-nowrap",
                active
                  ? "bg-primary text-white shadow-lg shadow-primary/20"
                  : "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05]",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {s.name}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
