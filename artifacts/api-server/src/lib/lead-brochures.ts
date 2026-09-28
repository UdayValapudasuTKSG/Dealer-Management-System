import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, brochuresTable, documentsTable, vehiclesTable } from "@workspace/db";
import { ObjectStorageService, objectStorageClient } from "./objectStorage";

// The seven original PDFs and the email-optimized Sealion derivative are in
// private App Storage. Keys are content-addressed, not filesystem paths;
// production never needs attached_assets or development database seed rows.
export const GT_BROCHURES = [
  { id: "sealion-7", title: "BYD Sealion 7 EV flyer (email-optimized copy)", fileName: "BYD-Sealion-7-Email-Optimized.pdf", sizeBytes: 1500239, sha: "7ed69e38a3a2d69f4b4e7a3006cba46d81dfba6667b7e26b025c6d572dec21e6", originalSha: "aaf2ea1f172279557c36b9e4a2b2c34ec568cf6e3daa60bf2dae99c7d4c98a0d", originalSizeBytes: 88317429 },
  { id: "dolphin-mini", title: "BYD Dolphin Mini brochure", fileName: "BYD-Dolphin-Mini-Brochure.pdf", sizeBytes: 5043698, sha: "26e21a35c479d2023309e6809d52b6c276b39ac224c4401889b72ea3778e97b3" },
  { id: "atto-8", title: "BYD Atto 8 brochure", fileName: "BYD-Atto-8-Brochure.pdf", sizeBytes: 2547726, sha: "862ba9fc6b2908ceb85213c5bcc8dcf455ed7b128cd9a220130dcac2b886d3cd" },
  { id: "shark", title: "BYD Shark brochure", fileName: "BYD-Shark-Brochure.pdf", sizeBytes: 1646884, sha: "bd58361d6d4f5fa935a8f9c59a35681c8057a08b993d9cfbef1c6e44fe3ce3a6" },
  { id: "song-plus-dmi", title: "BYD Song Plus DM-i brochure", fileName: "BYD-Song-Plus-DM-i-Brochure.pdf", sizeBytes: 959502, sha: "c2ca09a9f609d45e1616fcbf1ef7885318c646208b4944f4375c2dd2e6df8098" },
  { id: "song-pro", title: "BYD Song Pro brochure", fileName: "BYD-Song-Pro-Brochure.pdf", sizeBytes: 3614283, sha: "a8dafabff723049e98c6f36b4454c5716e39e64157f1c89dc498d9bf9e4a311e" },
  { id: "yuan-plus", title: "BYD Yuan Plus brochure", fileName: "BYD-Yuan-Plus-Brochure.pdf", sizeBytes: 2626951, sha: "b0fe02279391ff916fafb380c4025a8ab5bf76f01ff8d0ff61a6c83c24d060ed" },
] as const;

export const BROCHURE_ATTACHMENT_LIMIT = 20 * 1024 * 1024;
export const MAX_BROCHURES_PER_EMAIL = 7;
export const brochureCatalog = GT_BROCHURES.map(({ id, title, fileName, sizeBytes }) => ({
  id, title, fileName, sizeBytes, sendable: sizeBytes <= BROCHURE_ATTACHMENT_LIMIT,
}));

export type BrochureSnapshot = {
  id: string; title: string; fileName: string; sizeBytes: number; sha: string; objectPath: string;
};

export function safeBrochureFileName(name: string): string {
  // Never pass paths, control characters or MIME header delimiters into SMTP.
  const base = name.trim().replace(/\.pdf$/i, "").replace(/[^a-zA-Z0-9._ -]/g, "-")
    .replace(/^\.+/, "").trim().slice(0, 116);
  if (!base) throw new Error("Enter a valid PDF filename.");
  return `${base}.pdf`;
}

export function brochureView(b: typeof brochuresTable.$inferSelect) {
  return { id: b.id, title: b.title, fileName: b.fileName, sizeBytes: b.sizeBytes,
    sendable: b.sizeBytes <= BROCHURE_ATTACHMENT_LIMIT, active: b.active };
}

export async function listBrochures(dealerId: number) {
  const custom = await db.select().from(brochuresTable).where(eq(brochuresTable.dealerId, dealerId));
  return [
    ...(dealerId === 1 ? brochureCatalog.filter((b) => !custom.some((row) => row.id === b.id)) : []),
    ...custom.filter((b) => b.active).map(brochureView),
  ];
}

export async function selectDealerBrochures(dealerId: number, ids: string[]): Promise<BrochureSnapshot[]> {
  if (!ids.length || ids.length > MAX_BROCHURES_PER_EMAIL || new Set(ids).size !== ids.length)
    throw new Error("Select between 1 and 7 distinct brochures.");
  const custom = await db.select().from(brochuresTable).where(and(
    eq(brochuresTable.dealerId, dealerId)));
  const selected = ids.map((id) => {
    const b = custom.find((item) => item.id === id);
    if (b) return b.active ? { id, title: b.title, fileName: b.fileName, sha: b.sha,
      sizeBytes: b.sizeBytes, objectPath: b.objectPath } : null;
    const builtin = dealerId === 1 ? GT_BROCHURES.find((item) => item.id === id) : undefined;
    if (builtin) return { id, title: builtin.title, fileName: builtin.fileName,
      sha: builtin.sha, sizeBytes: builtin.sizeBytes,
      objectPath: `/objects/brochures/dealer-1/${builtin.sha}.pdf` };
    return null;
  });
  if (selected.some((b) => !b)) throw new Error("Unknown or archived brochure selected.");
  const brochures = selected as BrochureSnapshot[];
  if (brochures.reduce((n, b) => n + b.sizeBytes, 0) > BROCHURE_ATTACHMENT_LIMIT)
    throw new Error("Brochures exceed the 20 MB attachment limit. Select fewer brochures.");
  return brochures;
}

export async function commitBrochureUpload(dealerId: number, stagedPath: string) {
  if (!new RegExp(`^/objects/uploads/dealer-${dealerId}/[0-9a-f-]{36}$`, "i").test(stagedPath))
    throw new Error("Upload a PDF for the active dealership first.");
  const [doc] = await db.select({ id: documentsTable.id }).from(documentsTable)
    .where(eq(documentsTable.storageKey, stagedPath)).limit(1);
  const [vehicle] = await db.select({ id: vehiclesTable.id }).from(vehiclesTable)
    .where(sql`${vehiclesTable.imageUrl} = ${stagedPath} OR ${vehiclesTable.images} @> ${JSON.stringify([stagedPath])}::jsonb`).limit(1);
  if (doc || vehicle) throw new Error("This upload already belongs to another record. Upload a new PDF.");
  const storage = new ObjectStorageService();
  const staged = await storage.getObjectEntityFile(stagedPath);
  const [metadata] = await staged.getMetadata();
  const size = Number(metadata.size);
  if (!Number.isInteger(size) || size < 8 || size > BROCHURE_ATTACHMENT_LIMIT)
    throw new Error("PDF must be between 8 bytes and 20 MB.");
  if (metadata.contentType !== "application/pdf")
    throw new Error("Uploaded file must be a PDF.");
  const [bytes] = await staged.download();
  if (bytes.length !== size || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
    throw new Error("Uploaded file is not a valid PDF.");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const dir = storage.getPrivateObjectDir().replace(/^\/|\/$/g, "");
  const [bucketName, ...prefix] = dir.split("/");
  const key = `brochure-library/dealer-${dealerId}/${randomUUID()}.pdf`;
  const destination = objectStorageClient.bucket(bucketName).file([...prefix, key].join("/"));
  await destination.save(bytes, { contentType: "application/pdf", resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
  // Do not delete the immutable object during edits or archive: queued emails
  // refer to this exact object, hash and filename, not to the mutable row.
  try { await staged.delete(); } catch { /* orphan staging key expires operationally */ }
  return { objectPath: `/objects/${key}`, sha, sizeBytes: size, objectFile: destination };
}

export function selectBrochures(ids: string[]) {
  if (!ids.length || ids.length > GT_BROCHURES.length || new Set(ids).size !== ids.length)
    throw new Error("Select between 1 and 7 distinct brochures.");
  const selected = ids.map((id) => GT_BROCHURES.find((b) => b.id === id));
  if (selected.some((b) => !b)) throw new Error("Unknown brochure selected.");
  const brochures = selected as Array<(typeof GT_BROCHURES)[number]>;
  if (brochures.reduce((n, b) => n + b.sizeBytes, 0) > BROCHURE_ATTACHMENT_LIMIT)
    throw new Error("Brochures exceed the 20 MB attachment limit. Select fewer brochures.");
  return brochures;
}

const storage = new ObjectStorageService();
export async function loadBrochureAttachments(ids: string[]) {
  const brochures = selectBrochures(ids);
  return loadBrochureSnapshotAttachments(brochures.map((b) => ({
    id: b.id, title: b.title, fileName: b.fileName, sizeBytes: b.sizeBytes, sha: b.sha,
    objectPath: `/objects/brochures/dealer-1/${b.sha}.pdf`,
  })));
}

export async function loadBrochureSnapshotAttachments(brochures: BrochureSnapshot[], dealerId?: number) {
  if (!Array.isArray(brochures) || !brochures.length || brochures.length > MAX_BROCHURES_PER_EMAIL ||
      brochures.reduce((n, b) => n + b.sizeBytes, 0) > BROCHURE_ATTACHMENT_LIMIT)
    throw new Error("Invalid brochure attachment snapshot.");
  return Promise.all(brochures.map(async (b) => {
    if (!/^[0-9a-f]{64}$/.test(b.sha) || b.fileName !== safeBrochureFileName(b.fileName) ||
        (dealerId !== undefined && !b.objectPath.startsWith(`/objects/brochure-library/dealer-${dealerId}/`) &&
          !(dealerId === 1 && b.objectPath.startsWith("/objects/brochures/dealer-1/"))) ||
        !/^\/objects\/(?:brochures\/dealer-1\/[0-9a-f]{64}\.pdf|brochure-library\/dealer-\d+\/[0-9a-f-]{36}\.pdf)$/.test(b.objectPath))
      throw new Error("Invalid brochure attachment snapshot.");
    const file = await storage.getObjectEntityFile(b.objectPath);
    const [metadata] = await file.getMetadata();
    if (Number(metadata.size) !== b.sizeBytes)
      throw new Error(`Brochure ${b.title} has changed size in storage; email not sent.`);
    const [content] = await file.download();
    if (createHash("sha256").update(content).digest("hex") !== b.sha)
      throw new Error(`Brochure ${b.title} failed integrity check; email not sent.`);
    return { filename: b.fileName, content, contentType: "application/pdf" };
  }));
}