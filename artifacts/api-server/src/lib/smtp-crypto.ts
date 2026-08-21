/**
 * AES-256-GCM authenticated encryption for dealer SMTP passwords.
 * Key is derived from SESSION_SECRET with an SMTP-specific purpose label so
 * a leaked SMTP ciphertext cannot be decrypted with another sub-key (and
 * vice versa — WhatsApp/other ciphertexts cannot decrypt SMTP secrets).
 *
 * Ciphertext wire format (all base64, colon-separated):
 *   <iv_b64>:<authTag_b64>:<ciphertext_b64>
 *
 * SERVER-ONLY. Never import from client-side code. Never log outputs of
 * decryptSmtpPassword.
 */
import crypto from "node:crypto";

const PURPOSE = "smtp-password-v1";
const ALGORITHM = "aes-256-gcm";

/** Derive a 32-byte purpose-specific key from SESSION_SECRET. */
function deriveKey(): Buffer {
  const secret = process.env["SESSION_SECRET"];
  if (!secret || secret.length < 16) {
    throw new Error(
      "SESSION_SECRET is missing or too short — required to encrypt SMTP passwords",
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

/** Encrypt an SMTP password. Returns the wire-format ciphertext string. */
export function encryptSmtpPassword(
  plaintext: string,
  dealerId: number,
): string {
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
 * Decrypt a wire-format ciphertext back to the SMTP password plaintext.
 * Throws on authentication failure or malformed input.
 * The result must never be logged or returned to a client.
 */
export function decryptSmtpPassword(
  ciphertext: string,
  dealerId: number,
): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) throw new Error("Invalid password ciphertext format");
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
