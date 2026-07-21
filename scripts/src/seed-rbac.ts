import { eq } from "drizzle-orm";
import {
  db,
  rolesTable,
  rolePermissionsTable,
  ROLE_DEFAULTS,
} from "@workspace/db";

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
