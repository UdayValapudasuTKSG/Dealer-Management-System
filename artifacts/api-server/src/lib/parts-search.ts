/** Commas, semicolons and pasted lines separate OR terms; spaces stay in phrases. */
export function partsSearchTerms(search: string): string[] {
  return [...new Set(search.split(/[,;\r\n]+/).map(s => s.trim()).filter(Boolean))];
}

export function literalPartPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}
