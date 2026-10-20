// Explicit one-request operational recovery. No bulk queue drains or hold releases.
if (process.env.PROCESS_DUMMY_POS_SALE !== "1" || !process.env.PROD_DATABASE_URL) throw Error("Explicit opt-in required");
process.env.DATABASE_URL = process.env.PROD_DATABASE_URL;
process.env.EXTERNAL_DATABASE_URL = process.env.PROD_DATABASE_URL;
process.env.OUTBOX_WORKER_DISABLED = "1";
const { db, pool, erpnextSyncJobsTable: jobs } = await import("@workspace/db");
const { eq, and, inArray } = await import("drizzle-orm");
const { postPartsPosRequest } = await import("../lib/erpnext/parts-pos");
const { saveErpnextRef } = await import("../lib/erpnext/sync");
try {
  const ctx = (await pool.query(`SELECT d.name,c.site_url,c.company_name,c.enabled FROM dealers d
    JOIN erpnext_connections c ON c.dealer_id=d.id WHERE d.id=2`)).rows[0];
  if (ctx?.name !== "CAM Motors Dummy" || ctx.site_url.replace(/\/+$/, "") !== "https://erpnext-jcy-qlx.m.frappe.cloud" ||
      ctx.company_name !== "GT AUTOMOTIVE" || !ctx.enabled) throw Error("Dummy target mismatch");
  const [job] = await db.select().from(jobs).where(and(eq(jobs.id, 8108), eq(jobs.dealerId, 2)));
  if (!job || job.doctype !== "AURA Parts POS" || job.entityId !== 1) throw Error("Wrong job");
  if (job.status === "succeeded") { console.log("Already succeeded; no changes"); }
  else {
    const held = await pool.query(`SELECT id FROM erpnext_sync_jobs WHERE dealer_id=2 AND entity_type=$1
      AND entity_id=$2 AND payload ? 'financeReviewHold'`, [job.entityType, job.entityId]);
    if (held.rowCount) throw Error("Finance hold; will not process");
    const request = (await pool.query("SELECT status,created_by,decided_by FROM parts_pos_requests WHERE dealer_id=2 AND id=1")).rows[0];
    if (!request || !["approved", "failed"].includes(request.status) || !request.decided_by || request.decided_by === request.created_by)
      throw Error("Independent Finance approval missing");
    const [claimed] = await db.update(jobs).set({ status: "processing", updatedAt: new Date() })
      .where(and(eq(jobs.id, job.id), eq(jobs.dealerId, 2), inArray(jobs.status, ["queued", "failed"]))).returning();
    if (!claimed) throw Error("Already claimed; no second execution");
    try {
      const { docName } = await postPartsPosRequest(claimed);
      if (docName) await saveErpnextRef(2, claimed.entityType, claimed.entityId, claimed.doctype, docName);
      await db.update(jobs).set({ status: "succeeded", attempts: claimed.attempts + 1, lastError: null,
        erpnextDocName: docName, completedAt: new Date(), nextAttemptAt: null, updatedAt: new Date() }).where(eq(jobs.id, claimed.id));
      console.log(JSON.stringify({ job: claimed.id, status: "succeeded", document: docName }));
    } catch (err) {
      await db.update(jobs).set({ status: "failed", attempts: claimed.attempts + 1,
        lastError: "Targeted dummy posting failed; inspect POS request and ERP draft before retry.",
        nextAttemptAt: new Date(Date.now() + 3600000), updatedAt: new Date() }).where(eq(jobs.id, claimed.id));
      console.error(JSON.stringify({ error: err instanceof Error ? err.name : "Error",
        detail: err instanceof Error && err.name !== "ErpnextError" ? err.message : "ERP rejected posting; inspect request" }));
      process.exitCode = 1;
    }
  }
} finally { await pool.end(); }
