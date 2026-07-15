import { eq } from "drizzle-orm";
import {
  db,
  rolesTable,
  rolePermissionsTable,
  PERMISSION_MODULES,
  PERMISSION_CATEGORIES,
  type PermissionModule,
  type PermissionCategory,
} from "@workspace/db";

type Grant = Partial<Record<PermissionModule, PermissionCategory[]>>;

const ALL: Grant = Object.fromEntries(
  PERMISSION_MODULES.map((m) => [m, [...PERMISSION_CATEGORIES]]),
);

const ROLE_DEFAULTS: {
  name: string;
  description: string;
  grants: Grant;
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

async function main() {
  for (const role of ROLE_DEFAULTS) {
    const existing = await db
      .select()
      .from(rolesTable)
      .where(eq(rolesTable.name, role.name));

    let roleId: number;
    if (existing.length > 0) {
      roleId = existing[0]!.id;
      // Backfill grants only for modules the role has no rows for yet, so
      // custom per-role permission edits are preserved.
      const currentModules = new Set(
        (
          await db
            .select({ module: rolePermissionsTable.module })
            .from(rolePermissionsTable)
            .where(eq(rolePermissionsTable.roleId, roleId))
        ).map((r) => r.module),
      );
      const missing = Object.entries(role.grants).flatMap(
        ([module, categories]) =>
          currentModules.has(module)
            ? []
            : (categories ?? []).map((category) => ({
                roleId,
                module,
                category,
              })),
      );
      if (missing.length > 0) {
        await db
          .insert(rolePermissionsTable)
          .values(missing)
          .onConflictDoNothing();
        console.log(
          `Role exists, backfilled ${missing.length} grants: ${role.name}`,
        );
      } else {
        console.log(`Role exists, up to date: ${role.name}`);
      }
      continue;
    } else {
      const [created] = await db
        .insert(rolesTable)
        .values({
          name: role.name,
          description: role.description,
          isSystem: true,
          createdBy: "system",
        })
        .returning();
      roleId = created!.id;
    }

    const rows = Object.entries(role.grants).flatMap(([module, categories]) =>
      (categories ?? []).map((category) => ({ roleId, module, category })),
    );
    if (rows.length > 0) {
      await db.insert(rolePermissionsTable).values(rows).onConflictDoNothing();
    }
    console.log(`Seeded role: ${role.name} (${rows.length} grants)`);
  }
  console.log("RBAC seed complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
