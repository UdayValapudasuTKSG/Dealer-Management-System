import { Pagination } from "@/components/pagination";

type ListPaginationProps = {
  label: string;
  total: number;
  start: number;
  end: number;
  page: number;
  pageCount: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
};

export function ListPagination({ label, total, start, end, ...pagination }: ListPaginationProps) {
  return (
    <nav aria-label={`${label} pagination`} className="space-y-2 pt-3">
      <p className="text-center text-xs text-muted-foreground" aria-live="polite">
        {total === 0 ? `0 ${label}` : `Showing ${start}–${end} of ${total} ${label}`}
      </p>
      <Pagination {...pagination} />
    </nav>
  );
}