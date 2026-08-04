/**
 * Seed/relink tool for imported quote PDFs (lead documents of type "quote").
 *
 * Usage (from artifacts/api-server, any tsx binary works):
 *   tsx src/scripts/quote-documents-seed.ts export [--dealer 1] [--out seeds/quote-documents.seed.json]
 *   tsx src/scripts/quote-documents-seed.ts apply  [--dealer 1] [--seed seeds/quote-documents.seed.json] [--pdf-dir /path/to/Quote_PDFs]
 *
 * export — snapshots every linked quote document for the dealer into a seed
 *   JSON file (lead name/email/phone + file name + storage key + metadata).
 *   Commit this file so it travels with the codebase.
 *
 * apply — against ANY database (e.g. a fresh cloud/production DB after
 *   deployment), re-creates the document links:
 *     1. Matches each seed entry to a lead by email, then phone, then
 *        normalized name (most recent lead wins on ties).
 *     2. Skips entries whose (lead, fileName) document already exists —
 *        fully idempotent, safe to re-run.
 *     3. Reuses the recorded storage key if the object still exists in the
 *        bucket; otherwise re-uploads the PDF from --pdf-dir (the unzipped
 *        Quote_PDFs folder) under a fresh key.
 *
 * The target database is whatever @workspace/db resolves (DATABASE_URL, or
 * EXTERNAL_DATABASE_URL when NODE_ENV=production).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, documentsTable, leadsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { objectStorageClient } from "../lib/objectStorage";

type SeedEntry = {
  leadName: string;
  leadEmail: string | null;
  leadPhone: string | null;
  fileName: string;
  storageKey: string | null;
  mimeType: string;
  sizeBytes: number;
  comments: string | null;
  uploadedBy: string | null;
};

const argv = process.argv.slice(2);
const cmd = argv[0];
function arg(name: string, dflt: string) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const DEALER_ID = Number(arg("dealer", "1"));
const SEED_PATH = path.resolve(
  arg("seed", arg("out", "seeds/quote-documents.seed.json")),
);
const PDF_DIR = arg("pdf-dir", "");

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function parseObjectPath(p: string) {
  if (!p.startsWith("/")) p = `/${p}`;
  const parts = p.split("/");
  return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
}

/** Map a "/objects/..." storage key back to bucket + object name. */
function keyToObject(storageKey: string) {
  const privateDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateDir) throw new Error("PRIVATE_OBJECT_DIR not set");
  const rel = storageKey.replace(/^\/objects\//, "");
  return parseObjectPath(`${privateDir}/${rel}`);
}

async function exportSeed() {
  const rows = await db
    .select({
      fileName: documentsTable.fileName,
      storageKey: documentsTable.storageKey,
      mimeType: documentsTable.mimeType,
      sizeBytes: documentsTable.sizeBytes,
      comments: documentsTable.comments,
      uploadedBy: documentsTable.uploadedBy,
      leadName: leadsTable.name,
      leadEmail: leadsTable.email,
      leadPhone: leadsTable.phone,
    })
    .from(documentsTable)
    .innerJoin(leadsTable, eq(documentsTable.entityId, leadsTable.id))
    .where(
      and(
        eq(documentsTable.dealerId, DEALER_ID),
        eq(documentsTable.entityType, "lead"),
        eq(documentsTable.type, "quote"),
      ),
    );

  const entries: SeedEntry[] = rows.map((r) => ({
    leadName: r.leadName ?? "",
    leadEmail: r.leadEmail ?? null,
    leadPhone: r.leadPhone ?? null,
    fileName: r.fileName,
    storageKey: r.storageKey ?? null,
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    comments: r.comments ?? null,
    uploadedBy: r.uploadedBy ?? null,
  }));

  fs.mkdirSync(path.dirname(SEED_PATH), { recursive: true });
  fs.writeFileSync(
    SEED_PATH,
    JSON.stringify({ dealerId: DEALER_ID, exportedAt: new Date().toISOString(), entries }, null, 2),
  );
  console.log(`Exported ${entries.length} quote-document links to ${SEED_PATH}`);
}

async function applySeed() {
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, "utf-8")) as {
    entries: SeedEntry[];
  };

  const leads = await db
    .select({
      id: leadsTable.id,
      name: leadsTable.name,
      email: leadsTable.email,
      phone: leadsTable.phone,
      createdAt: leadsTable.createdAt,
    })
    .from(leadsTable)
    .where(and(eq(leadsTable.dealerId, DEALER_ID), isNull(leadsTable.deletedAt)));

  const pick = (cands: typeof leads) =>
    [...cands].sort(
      (a, b) =>
        ((b.createdAt as Date | null)?.getTime() ?? 0) -
        ((a.createdAt as Date | null)?.getTime() ?? 0),
    )[0];

  const byEmail = new Map<string, typeof leads>();
  const byPhone = new Map<string, typeof leads>();
  const byName = new Map<string, typeof leads>();
  for (const l of leads) {
    if (l.email) (byEmail.get(norm(l.email)) ?? byEmail.set(norm(l.email), []).get(norm(l.email))!).push(l);
    if (l.phone) (byPhone.get(l.phone.trim()) ?? byPhone.set(l.phone.trim(), []).get(l.phone.trim())!).push(l);
    const k = norm(l.name ?? "");
    (byName.get(k) ?? byName.set(k, []).get(k)!).push(l);
  }

  const existing = await db
    .select({ entityId: documentsTable.entityId, fileName: documentsTable.fileName })
    .from(documentsTable)
    .where(
      and(
        eq(documentsTable.dealerId, DEALER_ID),
        eq(documentsTable.entityType, "lead"),
        eq(documentsTable.type, "quote"),
      ),
    );
  // Dedupe by file name across the whole dealer — a quote PDF must never be
  // linked twice, even if the matcher would pick a different lead this run.
  const already = new Set(existing.map((d) => d.fileName));

  let linked = 0,
    skipped = 0,
    reuploaded = 0;
  const unmatched: string[] = [];
  const missingFile: string[] = [];

  for (const e of seed.entries) {
    // Match by NAME first — GT leads share placeholder emails/phones, so
    // contact fields only serve as fallbacks when the name finds nothing.
    const cands =
      byName.get(norm(e.leadName)) ||
      (e.leadEmail && byEmail.get(norm(e.leadEmail))) ||
      (e.leadPhone && byPhone.get(e.leadPhone.trim()));
    if (!cands || cands.length === 0) {
      unmatched.push(`${e.fileName} (${e.leadName})`);
      continue;
    }
    const lead = pick(cands);
    if (already.has(e.fileName)) {
      skipped++;
      continue;
    }

    // Ensure the file is actually in storage; re-upload from --pdf-dir if not.
    let storageKey = e.storageKey;
    let exists = false;
    if (storageKey) {
      try {
        const { bucketName, objectName } = keyToObject(storageKey);
        [exists] = await objectStorageClient.bucket(bucketName).file(objectName).exists();
      } catch {
        exists = false;
      }
    }
    if (!exists) {
      const src = PDF_DIR ? path.join(PDF_DIR, e.fileName) : "";
      if (!src || !fs.existsSync(src)) {
        missingFile.push(e.fileName);
        continue;
      }
      const privateDir = process.env.PRIVATE_OBJECT_DIR;
      if (!privateDir) throw new Error("PRIVATE_OBJECT_DIR not set");
      const objectId = randomUUID();
      const { bucketName, objectName } = parseObjectPath(
        `${privateDir}/uploads/dealer-${DEALER_ID}/${objectId}`,
      );
      await objectStorageClient
        .bucket(bucketName)
        .file(objectName)
        .save(fs.readFileSync(src), { contentType: e.mimeType, resumable: false });
      storageKey = `/objects/uploads/dealer-${DEALER_ID}/${objectId}`;
      reuploaded++;
    }

    await db.insert(documentsTable).values({
      dealerId: DEALER_ID,
      entityType: "lead",
      entityId: lead.id,
      type: "quote",
      fileName: e.fileName,
      storageKey,
      mimeType: e.mimeType,
      sizeBytes: e.sizeBytes,
      comments: e.comments,
      uploadedBy: e.uploadedBy ?? "import:quote-seed",
    });
    already.add(e.fileName);
    linked++;
    if (linked % 100 === 0) console.log(`...${linked} linked`);
  }

  console.log(
    `Done. linked=${linked} skipped(existing)=${skipped} reuploaded=${reuploaded} unmatched-leads=${unmatched.length} missing-files=${missingFile.length}`,
  );
  if (unmatched.length) {
    console.log("No matching lead in target DB:");
    unmatched.forEach((u) => console.log("  -", u));
  }
  if (missingFile.length) {
    console.log("Object missing in storage and PDF not found (pass --pdf-dir):");
    missingFile.forEach((u) => console.log("  -", u));
  }
}

(async () => {
  if (cmd === "export") await exportSeed();
  else if (cmd === "apply") await applySeed();
  else {
    console.error("Usage: quote-documents-seed.ts <export|apply> [--dealer N] [--seed path] [--pdf-dir path]");
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
