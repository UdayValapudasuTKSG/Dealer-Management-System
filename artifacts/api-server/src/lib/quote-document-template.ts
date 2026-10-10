/** GT-specific approval: other sending accounts must obtain their own template. */
export function quoteDocumentTemplate(dealerId: number) {
  return dealerId === 1
    ? { name: "vehicle_estimate_document", language: "en_US" } as const
    : null;
}

export function quoteDocumentTemplateParameters(data: Record<string, string>): string[] {
  const parameters = [data.name, data.quoteRef];
  if (parameters.some(value => !value?.trim())) {
    throw new Error("Quote document template requires the customer name and estimate reference");
  }
  return parameters;
}
