export const FEEDBACK_DAY_MS = 24 * 60 * 60 * 1000;
export function feedbackDueAt(completedAt: Date, delayDays: number): Date {
  return new Date(completedAt.getTime() + delayDays * FEEDBACK_DAY_MS);
}
