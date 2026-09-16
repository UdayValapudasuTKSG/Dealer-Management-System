export type TechnicianMetricInput = {
  availableHours: number;
  bookedHours: number;
  approvedSoldHours: number;
  invoicedSoldHours: number;
  invoicedHoursKnown: boolean;
  loggedActualHours: number;
  existingTimerHours: number;
};

export type TechnicianMetricOutput = TechnicianMetricInput & {
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
  return {
    ...input,
    availableHours: roundHours(input.availableHours),
    bookedHours: roundHours(input.bookedHours),
    approvedSoldHours: roundHours(input.approvedSoldHours),
    invoicedSoldHours: roundHours(input.invoicedSoldHours),
    loggedActualHours: roundHours(input.loggedActualHours),
    existingTimerHours: roundHours(input.existingTimerHours),
    remainingCapacityHours: roundHours(input.availableHours - input.bookedHours),
    efficiencyPct: pct(input.approvedSoldHours, input.loggedActualHours),
    productivityPct: pct(input.invoicedSoldHours, input.loggedActualHours),
  };
}

export function aggregateTechnicianMetrics(
  rows: TechnicianMetricOutput[],
): TechnicianMetricOutput {
  const totals = rows.reduce(
    (sum, row) => ({
      availableHours: sum.availableHours + row.availableHours,
      bookedHours: sum.bookedHours + row.bookedHours,
      approvedSoldHours: sum.approvedSoldHours + row.approvedSoldHours,
      invoicedSoldHours: sum.invoicedSoldHours + row.invoicedSoldHours,
      loggedActualHours: sum.loggedActualHours + row.loggedActualHours,
      existingTimerHours: sum.existingTimerHours + row.existingTimerHours,
    }),
    {
      availableHours: 0,
      bookedHours: 0,
      approvedSoldHours: 0,
      invoicedSoldHours: 0,
      loggedActualHours: 0,
      existingTimerHours: 0,
    },
  );
  return calculateTechnicianMetrics({
    ...totals,
    invoicedHoursKnown: rows.every((row) => row.invoicedHoursKnown),
  });
}