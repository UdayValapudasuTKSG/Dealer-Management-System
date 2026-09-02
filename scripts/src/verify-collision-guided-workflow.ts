/**
 * Focused guided-collision verifier. It is intentionally destructive only to
 * its timestamped fixture rows and refuses every non-local, non-development
 * target. Start the development API with COLLISION_DRAFT_VERIFIER=1 and
 * OUTBOX_WORKER_DISABLED=1 before running it.
 */
import { pool } from "@workspace/db";

const BASE = process.env.API_BASE ?? "http://localhost:80/api";
const prefix = `COLLISION-GUIDED-${Date.now()}`;
const manager = `${prefix.toLowerCase()}-manager@aura-test.local`;
const advisor = `${prefix.toLowerCase()}-advisor@aura-test.local`;
const foreign = `${prefix.toLowerCase()}-foreign@aura-test.local`;
const failures: string[] = [];
let passed = 0;
const check = (name: string, okay: boolean) => okay ? passed++ : failures.push(name);
const api = async (method: string, path: string, user?: string, dealerId?: number, body?: unknown) => {
  const response = await fetch(`${BASE}${path}`, { method, headers: {
    ...(user ? { "x-test-user-email": user } : {}),
    ...(dealerId ? { "x-dealer-id": String(dealerId) } : {}),
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, json: await response.json().catch(() => null) as any };
};
async function user(email: string, role: string, dealerId: number) {
  const found = await pool.query(`select id from roles where name=$1`, [role]);
  if (!found.rows[0]) throw new Error(`Missing fixture role ${role}`);
  const result = await pool.query(`insert into users(clerk_id,email,name,status) values($1,$2,$3,'active') returning id`,
    [`${prefix}-${email}`, email, `${prefix} ${role}`]);
  await pool.query(`insert into dealer_users(dealer_id,user_id,role_id) values($1,$2,$3)`,
    [dealerId, result.rows[0].id, found.rows[0].id]);
  return Number(result.rows[0].id);
}

async function main() {
  if (process.env.NODE_ENV === "production" || process.env.AURA_ALLOW_SYNTHETIC_VERIFY !== "true")
    throw new Error("Refusing synthetic verifier: set AURA_ALLOW_SYNTHETIC_VERIFY=true outside production");
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(?::\d+)?\/api$/.test(BASE))
    throw new Error(`Refusing non-local API target: ${BASE}`);
  await pool.query(`select pg_advisory_lock(hashtext('aura-verify-collision-guided-v1'))`);
  const ids: number[] = [];
  try {
    const dealers = await pool.query(`select id from dealers order by id limit 2`);
    if ((dealers.rowCount ?? 0) < 2) throw new Error("Verifier needs two existing dealerships");
    const ddl = await pool.query(`select conname as name from pg_constraint where conname in
      ('collision_checklist_audience_check','collision_checklist_status_check','collision_checklist_waiver_check','collision_communication_audience_check','collision_communication_status_check','part_requisitions_collision_claim_fk')
      union all select indexname as name from pg_indexes where indexname in
      ('collision_checklist_claim_key_unique','collision_checklist_gate_idx','collision_comms_generation_idempotency_unique','collision_comms_send_idempotency_unique','collision_portal_token_hash_unique','collision_portal_invite_idempotency_unique','part_requisitions_dealer_collision_claim_idx')`);
    check("guided-workflow migration constraints and indexes exist", ddl.rowCount === 13);
    const dealerId = Number(dealers.rows[0].id), otherDealerId = Number(dealers.rows[1].id);
    const managerId = await user(manager, "Service Manager", dealerId);
    await user(advisor, "Service Advisor", dealerId); await user(foreign, "Service Manager", otherDealerId);
    const customer = await pool.query(`insert into customers(dealer_id,name,email) values($1,$2,$3) returning id`,
      [dealerId, `${prefix} Customer`, `${prefix.toLowerCase()}@example.test`]);
    ids.push(Number(customer.rows[0].id));
    const order = await pool.query(`insert into service_orders(dealer_id,customer_id,customer_name,vehicle_info,type,scheduled_date)
      values($1,$2,$3,$4,'repair',current_date) returning id`, [dealerId, ids[0], `${prefix} Customer`, `${prefix} vehicle`]);
    const orderId = Number(order.rows[0].id); ids.push(orderId);
    const card = await pool.query(`insert into job_cards(dealer_id,service_order_id,title,status,technician_user_id)
      values($1,$2,$3,'open',$4) returning id`, [dealerId, orderId, prefix, managerId]); ids.push(Number(card.rows[0].id));
    const created = await api("POST", "/collision-claims", advisor, dealerId, {
      serviceOrderId: orderId, lossDate: "2026-01-01", insurerName: "Verifier Insurance", severity: "moderate",
    });
    const claimId = Number(created.json?.id); ids.push(claimId);
    check("claim creates and instantiates checklist", created.status === 201 && claimId > 0);
    const detail = await api("GET", `/collision-claims/${claimId}`, advisor, dealerId);
    const checklist = detail.json?.checklist ?? [];
    check("checklist defaults are persisted", checklist.length >= 10);
    const customerItem = checklist.find((x: any) => x.key === "customer_id");
    const damagePhotosItem = checklist.find((x: any) => x.key === "damage_photos");
    const evidenceGate = await api("POST", `/collision-claims/${claimId}/advance`, advisor, dealerId, { targetStatus: "estimate_drafted" });
    check("damage evidence blocks estimate drafting", evidenceGate.status === 422 && evidenceGate.json?.unmet?.includes("Damage photos"));
    const damageDocument = await pool.query(`insert into documents(dealer_id,entity_type,entity_id,type,file_name,storage_key,mime_type,size_bytes,uploaded_by)
      values($1,'collision_claim',$2,'other',$3,$4,'image/jpeg',1,$5) returning id`, [dealerId, claimId, `${prefix}-damage.jpg`, `${prefix}-damage.jpg`, manager]);
    await api("POST", `/collision-claims/${claimId}/checklist/${damagePhotosItem.id}/link`, advisor, dealerId, { documentId: damageDocument.rows[0].id });
    await api("POST", `/collision-claims/${claimId}/checklist/${damagePhotosItem.id}/verify`, manager, dealerId);
    const drafted = await api("POST", `/collision-claims/${claimId}/advance`, advisor, dealerId, { targetStatus: "estimate_drafted" });
    check("adjacent advance succeeds after evidence verification", drafted.status === 200);
    const blocked = await api("POST", `/collision-claims/${claimId}/advance`, advisor, dealerId, { targetStatus: "submitted" });
    check("exact missing-document stage gate", blocked.status === 422 && Array.isArray(blocked.json?.unmet) && blocked.json.unmet.includes("Customer identification"));
    const document = await pool.query(`insert into documents(dealer_id,entity_type,entity_id,type,file_name,storage_key,mime_type,size_bytes,uploaded_by)
      values($1,'collision_claim',$2,'other',$3,$4,'application/pdf',1,$5) returning id`, [dealerId, claimId, `${prefix}.pdf`, `${prefix}.pdf`, manager]);
    const linked = await api("POST", `/collision-claims/${claimId}/checklist/${customerItem.id}/link`, advisor, dealerId, { documentId: document.rows[0].id });
    const verified = await api("POST", `/collision-claims/${claimId}/checklist/${customerItem.id}/verify`, manager, dealerId);
    check("same-dealer document links then staff verifies", linked.status === 200 && linked.json?.status === "uploaded" && verified.status === 200 && verified.json?.status === "verified");
    const waiver = checklist.find((x: any) => x.status === "missing" && x.id !== customerItem.id);
    const waived = await api("POST", `/collision-claims/${claimId}/checklist/${waiver.id}/waive`, manager, dealerId, { reason: "Verifier documented exception" });
    check("approver waiver records reason", waived.status === 200 && waived.json?.waiverReason === "Verifier documented exception");
    const isolated = await api("GET", `/collision-claims/${claimId}`, foreign, otherDealerId);
    check("tenant isolation hides claim", isolated.status === 404);
    const invitation = await api("POST", `/collision-claims/${claimId}/portal-invitations`, advisor, dealerId, { email: `${prefix.toLowerCase()}@example.test`, idempotencyKey: `${prefix}-invite` });
    const token = invitation.json?.token as string;
    check("portal invitation returns one raw token", invitation.status === 201 && token?.length >= 32 && !("tokenHash" in invitation.json));
    const stored = await pool.query(`select token_hash from collision_portal_invitations where id=$1`, [invitation.json?.id]);
    check("raw portal token absent from DB", !!stored.rows[0]?.token_hash && stored.rows[0].token_hash !== token);
    const portal = await api("GET", `/collision-portal/${token}`);
    check("portal is sanitized and customer-only", portal.status === 200 && !JSON.stringify(portal.json).includes(token) && portal.json.checklist.every((x: any) => x.key !== "repair_estimate"));
    const note = await api("POST", `/collision-portal/${token}/note`, undefined, undefined, { note: "Please call me." });
    const limited = await api("POST", `/collision-portal/${token}/note`, undefined, undefined, { note: "Again." });
    check("customer note rate limits", note.status === 201 && limited.status === 429);
    const revoked = await api("POST", `/collision-claims/${claimId}/portal-invitations/${invitation.json.id}/revoke`, manager, dealerId);
    const unavailable = await api("GET", `/collision-portal/${token}`);
    check("revoked token returns gone", revoked.status === 200 && unavailable.status === 410);
    // Verify generated-draft behavior only with the explicitly injected dev seam.
    if (process.env.COLLISION_DRAFT_VERIFIER === "1") {
      const draft = await api("POST", `/collision-claims/${claimId}/communications/generate-draft`, manager, dealerId, { audience: "customer", purpose: "claim_received", idempotencyKey: `${prefix}-draft` });
      const edit = await api("PATCH", `/collision-claims/${claimId}/communications/${draft.json?.id}`, manager, dealerId, { subject: "Reviewed claim update" });
      const unconfirmed = await api("POST", `/collision-claims/${claimId}/communications/${draft.json?.id}/send`, manager, dealerId, { idempotencyKey: `${prefix}-send` });
      const sent = await api("POST", `/collision-claims/${claimId}/communications/${draft.json?.id}/send`, manager, dealerId, { confirm: true, idempotencyKey: `${prefix}-send` });
      const replay = await api("POST", `/collision-claims/${claimId}/communications/${draft.json?.id}/send`, manager, dealerId, { confirm: true, idempotencyKey: `${prefix}-send` });
      check("deterministic draft is saved but not sent", draft.status === 201 && draft.json?.model === "deterministic-verifier" && draft.json?.status === "draft");
      check("draft edit, confirmation, and idempotent queued SMTP outbox", edit.status === 200 && unconfirmed.status === 422 && sent.status === 200 && replay.status === 200 && sent.json?.outboxId === replay.json?.outboxId);
    }
  } finally {
    await pool.query(`delete from email_logs where dedupe_key like $1`, [`collision-communication:%${prefix}%`]);
    await pool.query(`delete from email_logs e using collision_claims c
      where c.vehicle_info=$1 and e.dedupe_key like ('collision:claim:' || c.id || ':%')`, [`${prefix} vehicle`]);
    await pool.query(`delete from notifications n using collision_claims c
      where c.vehicle_info=$1 and n.entity_type='collision_claim' and n.entity_id=c.id`, [`${prefix} vehicle`]);
    await pool.query(`delete from agent_runs where ref_type='collision_claim' and ref_id in (select id from collision_claims where vehicle_info=$1)`, [`${prefix} vehicle`]);
    await pool.query(`delete from documents where entity_type='collision_claim' and entity_id in (select id from collision_claims where vehicle_info=$1)`, [`${prefix} vehicle`]);
    await pool.query(`delete from collision_claims where vehicle_info=$1`, [`${prefix} vehicle`]);
    await pool.query(`delete from job_cards where title=$1`, [prefix]);
    await pool.query(`delete from service_orders where vehicle_info=$1`, [`${prefix} vehicle`]);
    await pool.query(`delete from customers where name=$1`, [`${prefix} Customer`]);
    await pool.query(`delete from dealer_users where user_id in (select id from users where email like $1)`, [`${prefix.toLowerCase()}%`]);
    await pool.query(`delete from users where email like $1`, [`${prefix.toLowerCase()}%`]);
    await pool.query(`select pg_advisory_unlock(hashtext('aura-verify-collision-guided-v1'))`);
  }
  console.log(`Collision guided verifier: ${passed} passed`);
  if (failures.length) throw new Error(`Failed checks: ${failures.join("; ")}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });