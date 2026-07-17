/**
 * One-shot multi-dealer tenancy migration (idempotent).
 * - Creates dealers + dealer_users tables
 * - Seeds GT Automotive and CAM Motors
 * - Adds dealer_id to every tenant table and backfills to CAM Motors
 * - Converts existing users' role into a CAM Motors membership
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

const NOT_NULL_TABLES = [
  "vehicles",
  "leads",
  "customers",
  "customer_documents",
  "customer_notes",
  "customer_personas",
  "deals",
  "appraisals",
  "finance_applications",
  "finance_documents",
  "banks",
  "los_submissions",
  "invoices",
  "payments",
  "receipts",
  "service_orders",
  "suppliers",
  "parts",
  "part_purchases",
  "job_cards",
  "job_card_parts",
  "coverage_plans",
  "service_invoices",
  "agents",
  "activity",
  "timeline_events",
  "gates",
  "conversations",
  "messages",
  "email_logs",
  "notifications",
  "tasks",
  "task_comments",
  "comm_notes",
  "bookings",
  "deliveries",
];
const NULLABLE_TABLES = ["audit_logs", "webhook_events"];

async function tableExists(name: string): Promise<boolean> {
  const res = await db.execute(
    sql`select 1 from information_schema.tables where table_name = ${name} and table_schema = 'public'`,
  );
  return res.rows.length > 0;
}

async function main() {
  await db.execute(sql`
    create table if not exists dealers (
      id serial primary key,
      name text not null unique,
      city text,
      country text,
      status text not null default 'active',
      created_by text,
      created_at timestamptz not null default now()
    )`);
  await db.execute(sql`
    create table if not exists dealer_users (
      id serial primary key,
      dealer_id integer not null references dealers(id) on delete cascade,
      user_id integer not null references users(id) on delete cascade,
      role_id integer not null references roles(id),
      is_general_manager boolean not null default false,
      created_at timestamptz not null default now()
    )`);
  await db.execute(
    sql`create unique index if not exists dealer_users_dealer_user_idx on dealer_users (dealer_id, user_id)`,
  );

  await db.execute(sql`
    insert into dealers (name, city, country)
    values ('GT Automotive', 'Georgetown', 'Guyana'), ('CAM Motors', 'Georgetown', 'Guyana')
    on conflict (name) do nothing`);

  const camRes = await db.execute(
    sql`select id from dealers where name = 'CAM Motors'`,
  );
  const camId = Number((camRes.rows[0] as { id: number }).id);
  console.log(`CAM Motors dealer id = ${camId}`);

  for (const t of [...NOT_NULL_TABLES, ...NULLABLE_TABLES]) {
    if (!(await tableExists(t))) {
      console.log(`skip (missing table): ${t}`);
      continue;
    }
    await db.execute(
      sql.raw(`alter table ${t} add column if not exists dealer_id integer`),
    );
    await db.execute(
      sql.raw(`update ${t} set dealer_id = ${camId} where dealer_id is null`),
    );
    if (NOT_NULL_TABLES.includes(t)) {
      await db.execute(
        sql.raw(`alter table ${t} alter column dealer_id set not null`),
      );
    }
    console.log(`migrated: ${t}`);
  }

  // Existing users -> CAM Motors members with their current role.
  const fallbackRole = await db.execute(
    sql`select id from roles where name = 'Sales Advisor' limit 1`,
  );
  const fallbackRoleId = (fallbackRole.rows[0] as { id: number } | undefined)
    ?.id;
  await db.execute(sql`
    insert into dealer_users (dealer_id, user_id, role_id, is_general_manager)
    select ${camId}, u.id, coalesce(u.role_id, ${fallbackRoleId ?? null}),
           coalesce(r.name = 'General Manager', false)
    from users u
    left join roles r on r.id = u.role_id
    where coalesce(u.role_id, ${fallbackRoleId ?? null}) is not null
    on conflict (dealer_id, user_id) do nothing`);

  console.log("Multi-dealer migration complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
