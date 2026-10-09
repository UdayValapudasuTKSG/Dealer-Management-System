/**
 * GT's approved manager-report template. Approval and GT branding belong to
 * GT's sending account; never assume this template is available to CAM.
 */
export function leadReportWhatsappTemplate(dealerId: number, kind: string) {
  if (dealerId !== 1 || kind !== "leads.source.report.daily") return null;
  return { name: "daily_lead_source_report", language: "en_US" } as const;
}
