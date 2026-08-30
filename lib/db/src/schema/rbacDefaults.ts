import type { PermissionModule, PermissionCategory } from "./roles";
import { PERMISSION_MODULES, PERMISSION_CATEGORIES } from "./roles";

export type RoleGrant = Partial<Record<PermissionModule, PermissionCategory[]>>;

const ALL: RoleGrant = Object.fromEntries(
  PERMISSION_MODULES.map((m) => [m, [...PERMISSION_CATEGORIES]]),
);

/**
 * Canonical default role catalog. Roles are GLOBAL (shared across dealers);
 * this list is used by both the seed script and dealer onboarding
 * provisioning to (re)create any missing system roles idempotently.
 */
export const ROLE_DEFAULTS: {
  name: string;
  description: string;
  grants: RoleGrant;
}[] = [
  {
    name: "General Manager",
    description: "Full oversight of the dealership; administers every module.",
    grants: ALL,
  },
  {
    name: "Sales Manager",
    description: "Runs the sales floor: pipeline, deals, appraisals, desking approvals.",
    grants: {
      dashboard: ["view", "export"],
      inventory: ["view", "edit", "assign", "export"],
      leads: ["view", "create", "edit", "delete", "assign", "export"],
      deals: ["view", "create", "edit", "delete", "approve", "reject", "assign", "export"],
      appraisals: ["view", "create", "edit", "approve", "reject"],
      finance: ["view"],
      deliveries: ["view", "create", "edit", "assign", "export"],
      customers: ["view", "create", "edit", "assign", "export"],
      approvals: ["view", "approve", "reject"],
      gra: ["view"],
      amber: ["view"],
      capacity: ["view", "edit"],
    },
  },
  {
    name: "Service Manager",
    description: "Owns the service lane: orders, scheduling, technician assignment.",
    grants: {
      dashboard: ["view"],
      inventory: ["view"],
      service: ["view", "create", "edit", "delete", "approve", "reject", "assign", "export"],
      parts: ["view", "create", "edit"],
      customers: ["view", "edit"],
      approvals: ["view", "approve", "reject"],
      amber: ["view"],
    },
  },
  {
    name: "Marketing Advisor",
    description: "Drives demand: campaigns, lead sourcing, and audience exports.",
    grants: {
      dashboard: ["view", "export"],
      leads: ["view", "create", "edit", "export"],
      customers: ["view", "export"],
    },
  },
  {
    name: "Finance Manager",
    description: "F&I desk: applications, lender routing, credit decisions.",
    grants: {
      dashboard: ["view"],
      deals: ["view", "edit", "approve"],
      finance: ["view", "create", "edit", "delete", "approve", "reject", "export"],
      customers: ["view"],
      approvals: ["view", "approve", "reject"],
      gra: ["view", "create", "edit"],
    },
  },
  {
    name: "Sales Advisor",
    description: "Works leads and desks deals for their customers.",
    grants: {
      dashboard: ["view"],
      inventory: ["view"],
      leads: ["view", "create", "edit", "assign"],
      deals: ["view", "create", "edit"],
      appraisals: ["view", "create"],
      deliveries: ["view", "create"],
      customers: ["view", "create", "edit"],
    },
  },
  {
    name: "Delivery Advisor",
    description: "Coordinates handover: delivery scheduling and vehicle prep.",
    grants: {
      dashboard: ["view"],
      inventory: ["view"],
      deals: ["view", "edit"],
      deliveries: ["view", "create", "edit", "assign"],
      service: ["view"],
      customers: ["view"],
    },
  },
  {
    name: "Service Advisor",
    description: "Front of the service lane: writes orders and keeps customers informed.",
    grants: {
      dashboard: ["view"],
      inventory: ["view"],
      service: ["view", "create", "edit", "assign"],
      parts: ["view"],
      customers: ["view", "create", "edit"],
    },
  },
  {
    name: "Parts Advisor",
    description: "Manages parts stock supporting service and repair.",
    grants: {
      dashboard: ["view"],
      inventory: ["view", "create", "edit"],
      service: ["view", "edit"],
      parts: ["view", "create", "edit", "delete", "export"],
    },
  },
  {
    name: "Technician",
    description: "Executes repair orders in the workshop.",
    grants: {
      service: ["view", "edit"],
      parts: ["view"],
    },
  },
  {
    name: "Marketing Coordinator",
    description: "Supports campaigns and keeps lead lists current.",
    grants: {
      dashboard: ["view"],
      leads: ["view", "create"],
      customers: ["view"],
    },
  },
];
