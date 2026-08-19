/**
 * AES-256-GCM authenticated encryption for WhatsApp access tokens.
 * Key is derived from SESSION_SECRET with a purpose-specific label so a
 * leaked WhatsApp ciphertext cannot be decrypted with another sub-key.
 *
 * Ciphertext wire format (all base64, colon-separated):
 *   <iv_b64>:<authTag_b64>:<ciphertext_b64>
 *
 * SERVER-ONLY. Never import from client-side code.
 */
import crypto from "node:crypto";

const PURPOSE = "whatsapp-access-token-v1";
const ALGORITHM = "aes-256-gcm";

/** Derive a 32-byte purpose-specific key from SESSION_SECRET. */
function deriveKey(): Buffer {
  const secret = process.env["SESSION_SECRET"];
  if (!secret || secret.length < 16) {
    throw new Error(
      "SESSION_SECRET is missing or too short — required to encrypt WhatsApp tokens",
    );
  }
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.alloc(0),
      Buffer.from(PURPOSE, "utf8"),
      32,
    ),
  );
}

/**
 * Encrypt plaintext access token.
 * Returns the wire-format ciphertext string (never the plaintext).
 */
export function encryptToken(plaintext: string, dealerId: number): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(`dealer:${dealerId}`, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a wire-format ciphertext back to the access token plaintext.
 * Throws on authentication failure or malformed input.
 * The result must never be logged.
 */
export function decryptToken(ciphertext: string, dealerId: number): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) throw new Error("Invalid token ciphertext format");
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const key = deriveKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(`dealer:${dealerId}`, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    "utf8",
  );
}
