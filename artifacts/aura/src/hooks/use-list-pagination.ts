import { useEffect, useState } from "react";

/** Paginate after filtering so counts and page boundaries describe visible results. */
export function useListPagination<T>(items: readonly T[], resetKey = "", defaultPageSize = 10) {
  const [state, setState] = useState({ resetKey, page: 1, pageSize: defaultPageSize });
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / state.pageSize));
  const page = state.resetKey === resetKey ? Math.min(state.page, pageCount) : 1;
  useEffect(() => {
    setState((current) =>
      current.resetKey === resetKey && current.page === page
        ? current
        : { ...current, resetKey, page },
    );
  }, [resetKey, page]);
  const start = total === 0 ? 0 : (page - 1) * state.pageSize + 1;
  const end = Math.min(page * state.pageSize, total);
  return {
    items: items.slice((page - 1) * state.pageSize, page * state.pageSize),
    total,
    start,
    end,
    page,
    pageCount,
    pageSize: state.pageSize,
    onPageChange: (next: number) => setState((current) => ({
      ...current, resetKey, page: Math.max(1, Math.min(next, pageCount)),
    })),
    onPageSizeChange: (size: number) => {
      if (!Number.isInteger(size) || size < 1) return;
      setState({ resetKey, page: 1, pageSize: size });
    },
  };
}