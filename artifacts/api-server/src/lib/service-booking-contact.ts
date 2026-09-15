/**
 * Normalize the one address that service reminder delivery is allowed to use.
 * Keeping this helper shared by the route and its contract test makes the
 * whitespace/no-recipient rule explicit: an absent recipient is never queued.
 */
export function effectiveServiceReminderRecipient(
  email: string | null | undefined,
): string | null {
  const normalized = email?.trim() ?? "";
  return normalized || null;
}