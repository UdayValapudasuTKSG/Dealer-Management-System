/** Pure calculations shared by reports and isolated tests. No database/providers. */
export function replenishmentCalculation(input: { issues: { date: Date; quantity: number }[]; now: Date; historyStart: Date; leadTimeDays: number; available: number; pending: number; min: number; max: number }) {
  const elapsed = Math.max(1, Math.ceil((input.now.getTime() - input.historyStart.getTime()) / 86400000));
  let weightedIssues = 0, weightedDays = 0;
  const month = input.now.getUTCMonth();
  const weight = (date: Date) => {
    const distance = Math.abs(date.getUTCMonth() - month);
    return Math.min(distance, 12 - distance) <= 1 ? 2 : 1;
  };
  for (let i = 0; i < elapsed; i++) weightedDays += weight(new Date(input.historyStart.getTime() + i * 86400000));
  for (const issue of input.issues) weightedIssues += issue.quantity * weight(issue.date);
  const dailyVelocity = weightedIssues / weightedDays;
  const leadTimeDemand = Math.ceil(dailyVelocity * input.leadTimeDays);
  const target = Math.max(input.min, Math.min(input.max, leadTimeDemand + input.min));
  const quantity = Math.max(0, Math.ceil(target - input.available - input.pending));
  return { dailyVelocity, leadTimeDemand, target, suggestedQuantity: quantity, daysUntilReorder: dailyVelocity ? Math.max(0, Math.floor((input.available + input.pending - input.min) / dailyVelocity) - input.leadTimeDays) : null, historyDays: elapsed, explanation: "Actual outbound issues; same calendar month and adjacent months receive 2× weighting over observed days (up to 24 months). Target is lead-time demand plus minimum, capped at maximum; pending orders deducted." };
}

export function reconciliationFlags(ordered: number, received: number, invoiced: number, expectedCost: number, invoiceCost: number, tolerance: number) {
  const priceVariancePercent = expectedCost === 0 ? (invoiceCost === 0 ? 0 : null) : Math.abs(invoiceCost - expectedCost) / expectedCost * 100;
  return { quantityMismatch: invoiced > received || invoiced > ordered, priceMismatch: priceVariancePercent === null || priceVariancePercent - tolerance > 1e-9, priceVariancePercent, partiallyReceived: received < ordered };
}

export function csv(rows: Record<string, unknown>[]) {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]!);
  // Spreadsheet imports interpret leading whitespace before formulas too.
  const cell = (v: unknown) => {
    let value = String(v ?? "");
    if (/^[\s]*[=+@-]/.test(value)) value = `'${value}`;
    return `"${value.replace(/"/g, '""')}"`;
  };
  return [columns.map(cell).join(","), ...rows.map(row => columns.map(c => cell(row[c])).join(","))].join("\r\n");
}