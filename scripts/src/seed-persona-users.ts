import { eq, isNull } from "drizzle-orm";
import { db, rolesTable, usersTable } from "@workspace/db";

const CLERK_API = "https://api.clerk.com/v1";
const SECRET = process.env.CLERK_SECRET_KEY;
if (!SECRET) {
  console.error("CLERK_SECRET_KEY is not set");
  process.exit(1);
}

type Persona = {
  role: string;
  first: string;
  last: string;
  email: string;
  password: string;
};

const PERSONAS: Persona[] = [
  { role: "General Manager", first: "Grace", last: "Mercer", email: "gm@aura-demo.com", password: "AuraGM!2026#mx41" },
  { role: "Sales Manager", first: "Victor", last: "Kane", email: "sales.manager@aura-demo.com", password: "AuraSM!2026#qt58" },
  { role: "Service Manager", first: "Rhea", last: "Douglas", email: "service.manager@aura-demo.com", password: "AuraSVM!2026#zp73" },
  { role: "Marketing Advisor", first: "Lena", last: "Ortiz", email: "marketing.advisor@aura-demo.com", password: "AuraMA!2026#kd26" },
  { role: "Finance Manager", first: "Marcus", last: "Vale", email: "finance.manager@aura-demo.com", password: "AuraFM!2026#rw94" },
  { role: "Sales Advisor", first: "Owen", last: "Blake", email: "sales.advisor@aura-demo.com", password: "AuraSA!2026#hn37" },
  { role: "Delivery Advisor", first: "Priya", last: "Nair", email: "delivery.advisor@aura-demo.com", password: "AuraDA!2026#vb62" },
  { role: "Service Advisor", first: "Caleb", last: "Ross", email: "service.advisor@aura-demo.com", password: "AuraSVA!2026#jf85" },
  { role: "Parts Advisor", first: "Nina", last: "Whitfield", email: "parts.advisor@aura-demo.com", password: "AuraPA!2026#cy19" },
  { role: "Technician", first: "Diego", last: "Fuentes", email: "technician@aura-demo.com", password: "AuraTech!2026#sl48" },
  { role: "Marketing Coordinator", first: "Amara", last: "Boyce", email: "marketing.coordinator@aura-demo.com", password: "AuraMC!2026#gu07" },
];

async function clerk(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(`${CLERK_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

async function findClerkUserByEmail(email: string) {
  const q = await clerk(`/users?email_address=${encodeURIComponent(email)}`);
  if (q.ok && Array.isArray(q.body) && q.body.length > 0) return q.body[0];
  return null;
}

async function ensureClerkUser(p: Persona) {
  const existing = await findClerkUserByEmail(p.email);
  if (existing) {
    // Reset password so the shared credentials always work.
    const upd = await clerk(`/users/${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        password: p.password,
        skip_password_checks: true,
        first_name: p.first,
        last_name: p.last,
      }),
    });
    if (!upd.ok) {
      throw new Error(
        `Failed to update ${p.email}: ${upd.status} ${JSON.stringify(upd.body)}`,
      );
    }
    return upd.body;
  }
  const created = await clerk(`/users`, {
    method: "POST",
    body: JSON.stringify({
      email_address: [p.email],
      password: p.password,
      first_name: p.first,
      last_name: p.last,
      skip_password_checks: true,
    }),
  });
  if (!created.ok) {
    throw new Error(
      `Failed to create ${p.email}: ${created.status} ${JSON.stringify(created.body)}`,
    );
  }
  return created.body;
}

async function verifyEmail(clerkUser: any) {
  const emailObj = clerkUser.email_addresses?.[0];
  if (!emailObj || emailObj.verification?.status === "verified") return;
  const res = await clerk(`/email_addresses/${emailObj.id}`, {
    method: "PATCH",
    body: JSON.stringify({ verified: true }),
  });
  if (!res.ok) {
    console.warn(
      `  warn: could not mark ${emailObj.email_address} verified (${res.status})`,
    );
  }
}

async function roleIdByName(name: string): Promise<number> {
  const [row] = await db
    .select({ id: rolesTable.id })
    .from(rolesTable)
    .where(eq(rolesTable.name, name));
  if (!row) throw new Error(`Role not found in DB: ${name} — run seed-rbac first`);
  return row.id;
}

async function main() {
  // Restore any users whose role was wiped by a schema push: user 1 is the
  // original owner (General Manager); anyone else defaults to Sales Advisor.
  const gmId = await roleIdByName("General Manager");
  const saId = await roleIdByName("Sales Advisor");
  const orphans = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(isNull(usersTable.roleId));
  for (const o of orphans) {
    await db
      .update(usersTable)
      .set({ roleId: o.id === 1 ? gmId : saId, updatedBy: "seed-persona-users" })
      .where(eq(usersTable.id, o.id));
    console.log(
      `restored role for user ${o.id} -> ${o.id === 1 ? "General Manager" : "Sales Advisor"}`,
    );
  }

  for (const p of PERSONAS) {
    const roleId = await roleIdByName(p.role);
    const cu = await ensureClerkUser(p);
    await verifyEmail(cu);
    const name = `${p.first} ${p.last}`;
    const [existing] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.clerkId, cu.id));
    if (existing) {
      await db
        .update(usersTable)
        .set({ email: p.email, name, roleId, updatedBy: "seed-persona-users" })
        .where(eq(usersTable.id, existing.id));
    } else {
      await db.insert(usersTable).values({
        clerkId: cu.id,
        email: p.email,
        name,
        roleId,
        createdBy: "seed-persona-users",
      });
    }
    console.log(`ok: ${p.role.padEnd(22)} ${p.email}`);
  }

  console.log("\nAll persona accounts are ready.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
