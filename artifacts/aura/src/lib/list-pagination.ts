/** Page only after the caller has applied all search, filter, and sort operations. */
export function paginate<T>(items: readonly T[], page: number, pageSize: number) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  return { items: items.slice((current - 1) * pageSize, current * pageSize), total, pages, page: current };
}