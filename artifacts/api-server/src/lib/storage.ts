import { promises as fs, createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Minimal file-storage abstraction. The current implementation writes to
 * local disk; swap `storage` for an S3-backed implementation later without
 * touching route code.
 */
export interface FileStorage {
  save(buffer: Buffer, originalName: string): Promise<string>;
  stream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}

const UPLOADS_DIR = path.resolve(
  process.env.UPLOADS_DIR ?? path.join(process.cwd(), "uploads"),
);

function resolveSafe(key: string): string {
  const full = path.resolve(UPLOADS_DIR, key);
  if (!full.startsWith(UPLOADS_DIR + path.sep)) {
    throw new Error("Invalid storage key");
  }
  return full;
}

class LocalDiskStorage implements FileStorage {
  async save(buffer: Buffer, originalName: string): Promise<string> {
    const ext = path.extname(originalName).slice(0, 12);
    const key = `${crypto.randomUUID()}${ext}`;
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    await fs.writeFile(resolveSafe(key), buffer);
    return key;
  }

  async stream(key: string): Promise<Readable> {
    const full = resolveSafe(key);
    await fs.access(full);
    return createReadStream(full);
  }

  async delete(key: string): Promise<void> {
    await fs.rm(resolveSafe(key), { force: true });
  }
}

export const storage: FileStorage = new LocalDiskStorage();
