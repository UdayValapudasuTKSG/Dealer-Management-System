import { Button } from "@/components/ui/button";

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
}: {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-2 pt-2">
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
    </div>
  );
}
