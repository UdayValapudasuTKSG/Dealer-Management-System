/** Shared role/source recognition: production custom roles retain their names. */
export function isCallCentreRole(role: string | null | undefined): boolean {
  return /^call cent(?:er|re) representative$/.test((role ?? "").trim().toLowerCase().replace(/\s+/g, " "));
}

export function isCallCentreSource(source: string | null | undefined): boolean {
  return ["website", "web", "whatsapp", "facebook", "instagram", "meta", "meta_lead_ads", "facebook_lead_ads"].includes(
    (source ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_"),
  );
}

export function isActiveCallCentreLead(lead: { callCentreStatus?: string | null }): boolean {
  return lead.callCentreStatus === "pending" || lead.callCentreStatus === "follow_up";
}