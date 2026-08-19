/**
 * Canonical WhatsApp recipient format: E.164 digits without a leading "+".
 * Guyana's seven-digit local numbers are expanded with country code 592.
 */
export function normalizeWhatsappPhone(value: string): string | null {
  let phone = value.replace(/^whatsapp:/i, "").replace(/\D/g, "");
  if (phone.startsWith("00")) phone = phone.slice(2);
  if (!phone || phone.startsWith("0")) return null;
  if (phone.length === 7) phone = `592${phone}`;
  if (phone.length < 8 || phone.length > 15) return null;
  return phone;
}