import { createHash } from "node:crypto";
import { ObjectStorageService } from "./objectStorage";

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
export const brochureCatalog = GT_BROCHURES.map(({ id, title, fileName, sizeBytes }) => ({
  id, title, fileName, sizeBytes, sendable: sizeBytes <= BROCHURE_ATTACHMENT_LIMIT,
}));

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
  return Promise.all(brochures.map(async (b) => {
    const file = await storage.getObjectEntityFile(`/objects/brochures/dealer-1/${b.sha}.pdf`);
    const [metadata] = await file.getMetadata();
    if (Number(metadata.size) !== b.sizeBytes)
      throw new Error(`Brochure ${b.title} has changed size in storage; email not sent.`);
    const [content] = await file.download();
    if (createHash("sha256").update(content).digest("hex") !== b.sha)
      throw new Error(`Brochure ${b.title} failed integrity check; email not sent.`);
    return { filename: b.fileName, content, contentType: "application/pdf" };
  }));
}