import { Button } from "@/components/ui/button";
import { StyledSelect } from "@/components/ui/styled-select";

/** Windowed page list, e.g. 1 … 4 5 6 … 19 (always shows first/last). */
export function pageNumbers(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set<number>([1, total, current - 1, current, current + 1]);
  const sorted = [...pages]
    .filter((p) => p >= 1 && p <= total)
    .sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) out.push("…");
    out.push(p);
    prev = p;
  }
  return out;
}

export function Pagination({
  page,
  pageCount,
  onPageChange,
  pageSize,
  pageSizeOptions = [10, 20, 30, 50],
  onPageSizeChange,
}: {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  pageSize?: number;
  pageSizeOptions?: number[];
  onPageSizeChange?: (size: number) => void;
}) {
  const showSize = pageSize != null && onPageSizeChange != null;
  if (pageCount <= 1 && !showSize) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
      {pageCount > 1 && (
      <>
      <Button
        variant="outline"
        size="sm"
        className="rounded-full px-4"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        Previous
      </Button>
      {pageNumbers(page, pageCount).map((p, i) =>
        p === "…" ? (
          <span
            key={`gap-${i}`}
            className="px-1.5 text-sm text-muted-foreground select-none"
          >
            …
          </span>
        ) : (
          <button
            key={p}
            onClick={() => onPageChange(p)}
            aria-current={p === page ? "page" : undefined}
            className={`h-9 min-w-9 rounded-full px-2 text-sm font-medium tabular-nums transition-colors ${
              p === page
                ? "bg-primary text-white shadow-lg shadow-primary/30"
                : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
            }`}
          >
            {p}
          </button>
        ),
      )}
      <Button
        variant="outline"
        size="sm"
        className="rounded-full px-4"
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
      >
        Next
      </Button>
      </>
      )}
      {showSize && (
        <label className="ml-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          Per page
          <StyledSelect
            value={String(pageSize)}
            onValueChange={(value) => onPageSizeChange(Number(value))}
            options={pageSizeOptions.map((n) => ({ value: String(n), label: String(n) }))}
            className="h-8 rounded-full bg-foreground/[0.04] border border-white/10 px-2.5 text-xs font-medium text-foreground focus:outline-none focus:border-primary/50"
          />
        </label>
      )}
    </div>
  );
}
