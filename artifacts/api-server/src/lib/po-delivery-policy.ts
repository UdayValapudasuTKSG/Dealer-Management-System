import { createHash } from "node:crypto";
export type PoMailSnapshot = { to_address: string; cc: string; subject: string; body_html: string; filename: string; sha256: string };
/** Does not render or regenerate anything: provider receives the final preview. */
export function exactPoMail(snapshot: PoMailSnapshot, pdf: Buffer) {
  if (createHash("sha256").update(pdf).digest("hex") !== snapshot.sha256) throw new Error("PO attachment integrity check failed");
  if (/[\r\n]/.test(snapshot.subject + snapshot.to_address + snapshot.cc)) throw new Error("Invalid mail header");
  return { to: snapshot.to_address, cc: snapshot.cc || undefined, subject: snapshot.subject, html: snapshot.body_html, headers: { "X-AURA-System": "1" }, attachments: [{ filename: snapshot.filename, content: pdf, contentType: "application/pdf" }] };
}
export function arrivalFailureStatus(attempts: number, providerAccepted: boolean, channel: string) {
  return providerAccepted ? "sending" : channel === "sms" && attempts < 4 ? "pending" : "failed";
}