/**
 * Development-only, no-send integration check of the private PDF catalog.
 * Never imports an email worker or calls SMTP.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (process.env.NODE_ENV === "production" || !url ||
    !["helium", "localhost", "127.0.0.1"].includes(new URL(url).hostname.toLowerCase()) ||
    (process.env.EXTERNAL_DATABASE_URL && url === process.env.EXTERNAL_DATABASE_URL))
  throw new Error("Refusing to test dealer brochures outside development.");
process.env.OUTBOX_WORKER_DISABLED = "1";

const { eq } = await import("drizzle-orm");
const { db, pool, dealersTable, brochuresTable } = await import("@workspace/db");
const { objectStorageClient, ObjectStorageService } = await import("../lib/objectStorage");
const {
  commitBrochureUpload, brochureView, listBrochures, loadBrochureSnapshotAttachments,
  safeBrochureFileName, selectDealerBrochures,
} = await import("../lib/lead-brochures");
const { routePermission, hasPermission } = await import("../middlewares/rbac");

const storage = new ObjectStorageService();
const dir = storage.getPrivateObjectDir().replace(/^\/|\/$/g, "");
const [bucket, ...prefix] = dir.split("/");
const objectFiles: Array<ReturnType<ReturnType<typeof objectStorageClient.bucket>["file"]>> = [];
let dealer1: number | undefined, dealer2: number | undefined;
async function stage(dealerId: number, contents: Buffer, contentType = "application/pdf") {
  const uuid = randomUUID();
  const key = [...prefix, `uploads/dealer-${dealerId}/${uuid}`].join("/");
  const file = objectStorageClient.bucket(bucket).file(key);
  objectFiles.push(file);
  await file.save(contents, { contentType });
  return `/objects/uploads/dealer-${dealerId}/${uuid}`;
}
try {
  const suffix = randomUUID();
  const [first] = await db.insert(dealersTable).values({ name: `brochure-test-${suffix}-a` }).returning();
  const [second] = await db.insert(dealersTable).values({ name: `brochure-test-${suffix}-b` }).returning();
  dealer1 = first.id; dealer2 = second.id;
  const body = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
  const upload = await stage(dealer1, body);
  await assert.rejects(() => commitBrochureUpload(dealer2!, upload), /active dealership/);
  const fake = await stage(dealer1, Buffer.from("not a PDF"));
  await assert.rejects(() => commitBrochureUpload(dealer1!, fake), /not a valid PDF/);
  const wrongMime = await stage(dealer1, body, "text/plain");
  await assert.rejects(() => commitBrochureUpload(dealer1!, wrongMime), /must be a PDF/);
  const stored = await commitBrochureUpload(dealer1, upload);
  objectFiles.push(stored.objectFile);
  const id = randomUUID();
  await db.insert(brochuresTable).values({
    id, dealerId: dealer1, title: "Test brochure", fileName: safeBrochureFileName("test.pdf"),
    objectPath: stored.objectPath, sha: stored.sha, sizeBytes: stored.sizeBytes,
  });
  assert.equal((await listBrochures(dealer1)).some((b) => b.id === id), true);
  assert.equal((await listBrochures(dealer2)).some((b) => b.id === id), false);
  assert.equal((await db.select().from(brochuresTable).where(eq(brochuresTable.dealerId, dealer2))).length, 0);
  await assert.rejects(() => selectDealerBrochures(dealer2!, [id]), /Unknown or archived/);
  const [snapshot] = await selectDealerBrochures(dealer1, [id]);
  assert.deepEqual((await loadBrochureSnapshotAttachments([snapshot], dealer1))[0].content, body);
  const replacementBody = Buffer.from("%PDF-1.7\n2 0 obj\n<<>>\nendobj\n%%EOF\n");
  const replacement = await commitBrochureUpload(dealer1, await stage(dealer1, replacementBody));
  objectFiles.push(replacement.objectFile);
  const [updated] = await db.update(brochuresTable).set({
    title: "Updated", fileName: "updated.pdf", objectPath: replacement.objectPath,
    sha: replacement.sha, sizeBytes: replacement.sizeBytes,
  }).where(eq(brochuresTable.id, id)).returning();
  assert.equal(brochureView(updated).title, "Updated");
  const [newSnapshot] = await selectDealerBrochures(dealer1, [id]);
  assert.equal(newSnapshot.fileName, "updated.pdf");
  assert.notEqual(snapshot.objectPath, newSnapshot.objectPath);
  assert.deepEqual((await loadBrochureSnapshotAttachments([snapshot], dealer1))[0].content, body,
    "queued snapshots continue to reference original bytes and filename");
  await db.update(brochuresTable).set({ active: false }).where(eq(brochuresTable.id, id));
  assert.equal((await listBrochures(dealer1)).some((b) => b.id === id), false);
  await assert.rejects(() => selectDealerBrochures(dealer1!, [id]), /Unknown or archived/);
  assert.deepEqual((await loadBrochureSnapshotAttachments([snapshot], dealer1))[0].content, body);
  await assert.rejects(() => loadBrochureSnapshotAttachments([snapshot], dealer2), /Invalid brochure/);
  // Production RBAC mapping: settings viewers can list, settings editors can write.
  const request = (method: string) => ({
    method, path: "/settings/brochures",
  }) as Parameters<typeof routePermission>[0];
  assert.deepEqual(routePermission(request("GET")), { module: "settings", category: "view" });
  assert.deepEqual(routePermission(request("POST")), { module: "settings", category: "edit" });
  assert.deepEqual(routePermission(request("DELETE")), { module: "settings", category: "edit" });
  const viewer = { permissions: [{ module: "settings", category: "view" }] } as Parameters<typeof hasPermission>[0];
  assert.equal(hasPermission(viewer, "settings", "view"), true);
  assert.equal(hasPermission(viewer, "settings", "edit"), false);
  console.log("PASS: PDF validation, dealer isolation, library changes, archived selection and immutable queued snapshots (no email sent).");
} finally {
  if (dealer1) await db.delete(brochuresTable).where(eq(brochuresTable.dealerId, dealer1));
  if (dealer1) await db.delete(dealersTable).where(eq(dealersTable.id, dealer1));
  if (dealer2) await db.delete(dealersTable).where(eq(dealersTable.id, dealer2));
  await Promise.all(objectFiles.map((f) => f.delete().catch(() => {})));
  await pool.end();
}