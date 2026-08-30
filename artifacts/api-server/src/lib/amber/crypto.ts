/**
 * AES-256-GCM authenticated encryption for Amber Connect credentials.
 * Key derived from SESSION_SECRET with a purpose-specific HKDF label so a
 * leaked Amber ciphertext cannot be decrypted with another sub-key.
 * Mirrors meta-crypto.ts / whatsapp-crypto.ts.
 *
 * Ciphertext wire format (all base64, colon-separated):
 *   <iv_b64>:<authTag_b64>:<ciphertext_b64>
 *
 * SERVER-ONLY. Never import from client-side code.
 */
import crypto from "node:crypto";

const PURPOSE = "amber-connect-credentials-v1";
const ALGORITHM = "aes-256-gcm";

function deriveKey(): Buffer {
  const secret = process.env["SESSION_SECRET"];
  if (!secret || secret.length < 16) {
    throw new Error(
      "SESSION_SECRET is missing or too short — required to encrypt Amber credentials",
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

export function encryptAmberSecret(plaintext: string, dealerId: number): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
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

/** Decrypt; throws on tamper/malformed input. Result must never be logged. */
export function decryptAmberSecret(wire: string, dealerId: number): string {
  const [ivB64, tagB64, ctB64] = wire.split(":");
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error("Malformed Amber credential ciphertext");
  }
  const key = deriveKey();
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAAD(Buffer.from(`dealer:${dealerId}`, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
