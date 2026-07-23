import { useEffect, useMemo, useState } from "react";
import { useSearch } from "wouter";

/** Numeric record id from a `?key=<id>` query param, or null. Used by triage
 * deep links to land on the specific record inside a collection page. */
export function useFocusParam(key: string): number | null {
  const search = useSearch();
  return useMemo(() => {
    const raw = new URLSearchParams(search).get(key);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  }, [search, key]);
}

/** Scroll the focused record into view once it renders, and highlight it
 * briefly. Returns whether the given id is currently highlighted. */
export function useFocusHighlight(
  focusId: number | null,
  domPrefix: string,
  ready: boolean,
): (id: number) => boolean {
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    if (focusId == null || !ready) return;
    const el = document.getElementById(`${domPrefix}-${focusId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setActive(focusId);
    const t = setTimeout(() => setActive(null), 4000);
    return () => clearTimeout(t);
  }, [focusId, domPrefix, ready]);
  return (id: number) => active === id;
}
