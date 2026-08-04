/**
 * One-off import: link uploaded Salesforce quote PDFs to GT Automotive leads.
 *
 * Reads /tmp/quotes/Quote_PDFs (unzipped attachment), matches each PDF's
 * customer name to a dealer-1 lead, uploads the file to private object
 * storage under the dealer-1 tenancy prefix, and inserts a `documents` row
 * (entity_type=lead, type=quote) so the PDF shows up on the lead's documents.
 *
 * Idempotent: skips files whose (entity, file_name) document already exists.
 * Ambiguous names resolve to the most recently created lead; unmatched files
 * are reported at the end and not imported.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, documentsTable, leadsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { objectStorageClient } from "../lib/objectStorage";

const DEALER_ID = 1;
const SRC_DIR = "/tmp/quotes/Quote_PDFs";

function parseObjectPath(p: string) {
  if (!p.startsWith("/")) p = `/${p}`;
  const parts = p.split("/");
  const bucketName = parts[1];
  const objectName = parts.slice(2).join("/");
  return { bucketName, objectName };
}

function norm(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

async function main() {
  const privateDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateDir) throw new Error("PRIVATE_OBJECT_DIR not set");

  // Manifest: Title,File,... (utf-8 BOM)
  const manifestRaw = fs
    .readFileSync(path.join(SRC_DIR, "_manifest.csv"), "utf-8")
    .replace(/^\uFEFF/, "");
  const lines = manifestRaw.split(/\r?\n/).filter(Boolean).slice(1);

  const leads = await db
    .select({
      id: leadsTable.id,
      name: leadsTable.name,
      createdAt: leadsTable.createdAt,
    })
    .from(leadsTable)
    .where(and(eq(leadsTable.dealerId, DEALER_ID), isNull(leadsTable.deletedAt)));

  const byName = new Map<string, { id: number; createdAt: Date | null }[]>();
  for (const l of leads) {
    const k = norm(l.name ?? "");
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push({ id: l.id, createdAt: l.createdAt as Date | null });
  }

  const existing = await db
    .select({
      entityId: documentsTable.entityId,
      fileName: documentsTable.fileName,
    })
    .from(documentsTable)
    .where(
      and(
        eq(documentsTable.dealerId, DEALER_ID),
        eq(documentsTable.entityType, "lead"),
        eq(documentsTable.type, "quote"),
      ),
    );
  const already = new Set(existing.map((d) => `${d.entityId}|${d.fileName}`));

  let imported = 0,
    skipped = 0,
    ambiguous = 0;
  const unmatched: string[] = [];

  for (const line of lines) {
    // naive CSV: fields contain no commas in this manifest except none; split safe
    const cols = line.split(",");
    const title = cols[0];
    const file = cols[1];
    if (!file || !file.toLowerCase().endsWith(".pdf")) continue;
    const filePath = path.join(SRC_DIR, file);
    if (!fs.existsSync(filePath)) {
      unmatched.push(`${file} (missing on disk)`);
      continue;
    }
    const custName = norm(title.split(/ - Q\d/)[0] ?? "");
    const candidates = byName.get(custName);
    if (!candidates || candidates.length === 0) {
      unmatched.push(file);
      continue;
    }
    let lead = candidates[0];
    if (candidates.length > 1) {
      ambiguous++;
      lead = [...candidates].sort(
        (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
      )[0];
    }
    if (already.has(`${lead.id}|${file}`)) {
      skipped++;
      continue;
    }

    const objectId = randomUUID();
    const fullPath = `${privateDir}/uploads/dealer-${DEALER_ID}/${objectId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const bytes = fs.readFileSync(filePath);
    await objectStorageClient
      .bucket(bucketName)
      .file(objectName)
      .save(bytes, { contentType: "application/pdf", resumable: false });

    await db.insert(documentsTable).values({
      dealerId: DEALER_ID,
      entityType: "lead",
      entityId: lead.id,
      type: "quote",
      fileName: file,
      storageKey: `/objects/uploads/dealer-${DEALER_ID}/${objectId}`,
      mimeType: "application/pdf",
      sizeBytes: bytes.length,
      comments: `Imported quote PDF (${title})`,
      uploadedBy: "import:salesforce-quotes",
    });
    already.add(`${lead.id}|${file}`);
    imported++;
    if (imported % 100 === 0) console.log(`...${imported} imported`);
  }

  console.log(
    `Done. imported=${imported} skipped(existing)=${skipped} ambiguous-resolved=${ambiguous} unmatched=${unmatched.length}`,
  );
  if (unmatched.length) {
    console.log("Unmatched files (no dealer-1 lead with this name):");
    for (const u of unmatched) console.log("  -", u);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
