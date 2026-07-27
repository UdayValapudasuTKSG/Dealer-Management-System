/**
 * Per-persona landing pages (01-personas.md):
 * each role enters the workspace on the page that matches its daily work.
 * RBAC still governs what each page shows — this is routing only.
 */
const ROLE_HOME: Record<string, string> = {
  "General Manager": "/reports",
  "Sales Manager": "/command-center",
  "Sales Advisor": "/command-center",
  "Delivery Advisor": "/deliveries",
  "Service Manager": "/service",
  "Service Advisor": "/service",
  Technician: "/service",
  "Parts Advisor": "/parts",
  "Finance Manager": "/finance",
  "Marketing Manager": "/reports",
  "Marketing Coordinator": "/reports",
  "Marketing Advisor": "/reports",
  "Dealer Admin": "/settings/users",
  Admin: "/settings/users",
};

/**
 * Returns the landing route for a role. Super admins land on the Platform
 * Console (AURA Realm) — a separate artifact, so callers must treat "/realm/"
 * as a full-page navigation, never a wouter redirect.
 */
export function roleHome(roleName: string | null | undefined, isSuperAdmin?: boolean): string {
  if (isSuperAdmin) return "/realm/";
  if (roleName && ROLE_HOME[roleName]) return ROLE_HOME[roleName];
  return "/command-center";
}
