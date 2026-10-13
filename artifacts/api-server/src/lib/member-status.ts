import { sql, eq } from "drizzle-orm";
import { dealerUsersTable, usersTable } from "@workspace/db";

// users.status is a legacy fallback only. Never update it from dealer settings.
// Both tables must be joined in queries using these expressions.
export const effectiveMemberStatus = sql<string>`coalesce(${dealerUsersTable.status}, ${usersTable.status})`;
export const activeMember = eq(effectiveMemberStatus, "active");
