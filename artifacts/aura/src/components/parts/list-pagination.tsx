import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { paginate } from "@/lib/list-pagination";
import { useAuthz } from "@/lib/auth";

export const PAGE_SIZES = [25, 50, 100] as const;

/** Pass an already filtered and sorted list; keep mutations and selections in the parent. */
export function useListPagination<T>(items: readonly T[], resetKey: string = "") {
  const { activeDealer } = useAuthz();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(25);
  useEffect(() => { setPage(1); }, [resetKey, activeDealer?.dealerId]);
  const result = paginate(items, page, pageSize);
  return {
    ...result,
    pageSize,
    controls: <PaginationControls total={result.total} page={result.page} pages={result.pages}
      pageSize={pageSize} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }} />,
  };
}

export function useServerPagination(total: number, resetKey: string = "") {
  const { activeDealer } = useAuthz();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(25);
  useEffect(() => { setPage(1); }, [resetKey, activeDealer?.dealerId]);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => { if (page > pages) setPage(pages); }, [page, pages]);
  const safePage = Math.min(page, pages);
  return { page: safePage, pageSize, offset: (safePage - 1) * pageSize,
    controls: <PaginationControls total={total} page={safePage} pages={pages} pageSize={pageSize}
      onPage={setPage} onPageSize={size => { setPageSize(size); setPage(1); }} /> };
}

export function PaginationControls({ total, page, pages, pageSize, onPage, onPageSize }: {
  total: number; page: number; pages: number; pageSize: number;
  onPage: (page: number) => void; onPageSize: (size: number) => void;
}) {
  return <nav aria-label="List pagination" className="flex flex-wrap items-center justify-between gap-3 py-3 text-xs text-muted-foreground">
    <span>Showing {total ? (page - 1) * pageSize + 1 : 0}–{Math.min(page * pageSize, total)} of {total}</span>
    <div className="flex items-center gap-2">
      <label>Rows per page{" "}
        <select aria-label="Rows per page" className="rounded border border-white/15 bg-background px-2 py-1" value={pageSize} onChange={e => onPageSize(Number(e.target.value))}>
          {PAGE_SIZES.map(size => <option key={size} value={size}>{size}</option>)}
        </select>
      </label>
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
      <span>Page {page} / {pages}</span>
      <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
    </div>
  </nav>;
}