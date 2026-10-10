/** The user confirmed this GT-branded template approved in GT's sending account. */
export function quoteDocumentWhatsappTemplate(dealerId: number) {
  return dealerId === 1
    ? { name: "vehicle_estimate_document", language: "en_US" } as const
    : null;
}

export function quoteDocumentTemplateParameters(data: Record<string, string>): string[] {
  if (!data.name?.trim() || !data.quoteRef?.trim()) {
    throw new Error("Quote document template requires the customer name and estimate reference.");
  }
  return [data.name, data.quoteRef];
}
