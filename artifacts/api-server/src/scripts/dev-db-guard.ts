/**
 * Fixture-write guard. Verifies the Replit development markers and the
 * ACTUAL connected database before any write. It never changes env binding:
 * it resolves the URL exactly as @workspace/db does and only refuses.
 */

export async function assertDevelopmentDatabase(): Promise<{ database: string; host: string }> {
  const problems: string[] = [];
  if (process.env.NODE_ENV === "production") problems.push("NODE_ENV=production");
  if (process.env.REPLIT_DEPLOYMENT) problems.push("REPLIT_DEPLOYMENT is set (deployed runtime)");
  if (!process.env.REPLIT_DEV_DOMAIN) problems.push("REPLIT_DEV_DOMAIN missing (not a Replit workspace runtime)");
  // Same resolution as lib/db/src/index.ts in non-production.
  const url = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
  if (!url) problems.push("no development database URL");
  const ext = process.env.EXTERNAL_DATABASE_URL;
  const hostOf = (u: string) => { try { const x = new URL(u); return `${x.hostname}:${x.port}/${x.pathname.slice(1)}`; } catch { return u; } };
  if (url && ext && hostOf(url) === hostOf(ext)) problems.push("development URL resolves to the production (EXTERNAL_DATABASE_URL) database");
  if (problems.length) throw new Error(`Refusing fixture writes: ${problems.join("; ")}`);
  const { pool } = await import("@workspace/db"); // the pool fixtures will write through
  {
    const { rows } = await pool.query<{ db: string; host: string | null; ro: string }>(
      "select current_database() as db, inet_server_addr()::text as host, current_setting('transaction_read_only') as ro");
    const live = rows[0]!;
    if (live.ro === "on") throw new Error("Refusing fixture writes: connected database is read-only");
    if (ext) {
      const e = new URL(ext);
      if (e.pathname.slice(1) === live.db && (e.hostname === live.host || e.hostname === new URL(url!).hostname)) {
        throw new Error("Refusing fixture writes: connected database matches the production database identity");
      }
    }
    return { database: live.db, host: live.host ?? "local" };
  }
}
