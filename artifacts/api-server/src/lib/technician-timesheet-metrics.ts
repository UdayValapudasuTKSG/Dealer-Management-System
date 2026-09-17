import { zonedAddDays, zonedDayKey, zonedStartOfDay } from "./timezone";

/**
 * The timer ledger is authoritative for automatic actuals.  A session is
 * deliberately attributed to the technician captured when it began, rather
 * than the job card's current assignee.
 */
export type TimerLedgerSegment = {
  id: number;
  dealerId: number;
  jobCardId: number;
  technicianUserId: number;
  technicianNameSnapshot: string | null;
  /** Timezone captured at the timer transition; preserves historical day cuts. */
  dealerTimezoneSnapshot: string;
  startedAt: Date;
  endedAt: Date | null;
};

export type AutomaticTimesheetSlice = TimerLedgerSegment & {
  workDate: string;
  startAt: Date;
  endAt: Date;
  durationSeconds: number;
};

/** A manual job/day correction visibly supersedes automatic slices for it. */
export function manualJobDayKey(
  technicianUserId: number,
  jobCardId: number,
): string {
  return `${technicianUserId}:${jobCardId}`;
}

export function shouldCountAutomaticSlice(
  manualJobKeys: ReadonlySet<string>,
  technicianUserId: number,
  jobCardId: number,
): boolean {
  return !manualJobKeys.has(manualJobDayKey(technicianUserId, jobCardId));
}

export type TimerCardResidualInput = {
  jobCardId: number;
  cumulativeTimerSeconds: number;
};

/**
 * Legacy timer residuals may only be calculated against captured elapsed
 * seconds for the SAME job card. Never subtract technician aggregates: a card
 * may be reassigned, cancelled, or later deleted while ledger evidence stays
 * with the original technician snapshot.
 */
export function calculateDealerTimerResidualHours(
  timerCards: readonly TimerCardResidualInput[],
  capturedSecondsByJobCard: ReadonlyMap<number, number>,
): number {
  const seconds = timerCards.reduce(
    (sum, card) =>
      sum +
      Math.max(
        0,
        card.cumulativeTimerSeconds -
          (capturedSecondsByJobCard.get(card.jobCardId) ?? 0),
      ),
    0,
  );
  return roundHours(seconds / 3600);
}

/**
 * Clip an active timer at `now`, then split it at *dealer-local* midnight.
 * This is intentionally timestamp based (rather than 24-hour arithmetic) so
 * daylight-saving days retain their actual elapsed duration.
 */
export function splitTimerSegmentByDealerDay(
  segment: TimerLedgerSegment,
  timezone: string,
  now = new Date(),
): AutomaticTimesheetSlice[] {
  // Only a running segment is clipped at report time. A closed ledger
  // interval is immutable evidence and must not be shortened by a caller's
  // report timestamp (including historical/future-boundary regression tests).
  const endsAt = segment.endedAt ?? now;
  if (endsAt.getTime() <= segment.startedAt.getTime()) return [];

  const slices: AutomaticTimesheetSlice[] = [];
  let cursor = segment.startedAt;
  while (cursor.getTime() < endsAt.getTime()) {
    const workDate = zonedDayKey(cursor, timezone);
    const nextMidnight = zonedStartOfDay(
      zonedAddDays(cursor, timezone, 1),
      timezone,
    );
    const sliceEnd =
      nextMidnight.getTime() < endsAt.getTime() ? nextMidnight : endsAt;
    const durationSeconds = Math.max(
      0,
      Math.round((sliceEnd.getTime() - cursor.getTime()) / 1000),
    );
    if (durationSeconds > 0) {
      slices.push({
        ...segment,
        workDate,
        startAt: cursor,
        endAt: sliceEnd,
        durationSeconds,
      });
    }
    cursor = sliceEnd;
  }
  return slices;
}

export type TechnicianMetricInput = {
  availableHours: number;
  bookedHours: number;
  approvedSoldHours: number;
  invoicedSoldHours: number;
  invoicedHoursKnown: boolean;
  /** Manual actuals included in this dealer-day report. */
  manualActualHours: number;
  /** Automatic timer-ledger actuals included in this dealer-day report. */
  automaticActualHours: number;
  /**
   * All timer-ledger elapsed time ever captured for this technician.  This is
   * not a daily measure; it is used only to identify the residual, historical
   * cumulative timer amount that cannot be truthfully assigned to a session.
   */
  capturedTimerHours: number;
  /** Legacy aggregate job-card timer total when it has a verified scope. */
  existingTimerHours: number;
  /**
   * Only a per-card residual calculation may set this. Technician rows use
   * zero because historical residuals deliberately have no tech identity.
   */
  unallocatedTimerHours?: number;
};

export type TechnicianMetricOutput = TechnicianMetricInput & {
  /** Manual + automatic actuals included in this dealer-day report. */
  capturedActualHours: number;
  /** Backward-compatible alias for capturedActualHours. */
  loggedActualHours: number;
  /** Cumulative timer amount without a captured technician/session identity. */
  unallocatedTimerHours: number;
  remainingCapacityHours: number;
  efficiencyPct: number | null;
  productivityPct: number | null;
};

export function roundHours(value: number): number {
  return Math.round(value * 100) / 100;
}

function pct(numerator: number, denominator: number): number | null {
  return denominator > 0 ? roundHours((numerator / denominator) * 100) : null;
}

export function calculateTechnicianMetrics(
  input: TechnicianMetricInput,
): TechnicianMetricOutput {
  const manualActualHours = roundHours(input.manualActualHours);
  const automaticActualHours = roundHours(input.automaticActualHours);
  const capturedActualHours = roundHours(
    input.manualActualHours + input.automaticActualHours,
  );
  const capturedTimerHours = roundHours(input.capturedTimerHours);
  const existingTimerHours = roundHours(input.existingTimerHours);
  return {
    ...input,
    availableHours: roundHours(input.availableHours),
    bookedHours: roundHours(input.bookedHours),
    approvedSoldHours: roundHours(input.approvedSoldHours),
    invoicedSoldHours: roundHours(input.invoicedSoldHours),
    manualActualHours,
    automaticActualHours,
    capturedActualHours,
    loggedActualHours: capturedActualHours,
    capturedTimerHours,
    existingTimerHours,
    unallocatedTimerHours: roundHours(input.unallocatedTimerHours ?? 0),
    remainingCapacityHours: roundHours(input.availableHours - input.bookedHours),
    efficiencyPct: pct(input.approvedSoldHours, capturedActualHours),
    productivityPct: pct(input.invoicedSoldHours, capturedActualHours),
  };
}

export function aggregateTechnicianMetrics(
  rows: TechnicianMetricInput[],
): TechnicianMetricOutput {
  const totals = rows.reduce(
    (sum, row) => ({
      availableHours: sum.availableHours + row.availableHours,
      bookedHours: sum.bookedHours + row.bookedHours,
      approvedSoldHours: sum.approvedSoldHours + row.approvedSoldHours,
      invoicedSoldHours: sum.invoicedSoldHours + row.invoicedSoldHours,
      manualActualHours: sum.manualActualHours + row.manualActualHours,
      automaticActualHours: sum.automaticActualHours + row.automaticActualHours,
      capturedTimerHours: sum.capturedTimerHours + row.capturedTimerHours,
      existingTimerHours: sum.existingTimerHours + row.existingTimerHours,
      unallocatedTimerHours:
        sum.unallocatedTimerHours + (row.unallocatedTimerHours ?? 0),
    }),
    {
      availableHours: 0,
      bookedHours: 0,
      approvedSoldHours: 0,
      invoicedSoldHours: 0,
      manualActualHours: 0,
      automaticActualHours: 0,
      capturedTimerHours: 0,
      existingTimerHours: 0,
      unallocatedTimerHours: 0,
    },
  );
  return calculateTechnicianMetrics({
    ...totals,
    invoicedHoursKnown: rows.every((row) => row.invoicedHoursKnown),
  });
}