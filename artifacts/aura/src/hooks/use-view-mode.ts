import { useCallback, useEffect, useState } from "react";

export type Density = "comfortable" | "compact";
export type Layout = "grid" | "list";

const DENSITY_KEY = "aura-density";
const DENSITY_EVENT = "aura-density-change";

function readDensity(): Density {
  try {
    const v = localStorage.getItem(DENSITY_KEY);
    return v === "comfortable" ? "comfortable" : "compact";
  } catch {
    return "compact";
  }
}

function readLayout(pageKey: string): Layout {
  try {
    const v = localStorage.getItem(`aura-view:${pageKey}`);
    return v === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export function useViewMode(pageKey: string) {
  const [density, setDensityState] = useState<Density>(readDensity);
  const [layout, setLayoutState] = useState<Layout>(() => readLayout(pageKey));

  useEffect(() => {
    setLayoutState(readLayout(pageKey));
  }, [pageKey]);

  useEffect(() => {
    const sync = () => setDensityState(readDensity());
    window.addEventListener(DENSITY_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(DENSITY_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const setDensity = useCallback((d: Density) => {
    try {
      localStorage.setItem(DENSITY_KEY, d);
    } catch {
      /* ignore */
    }
    setDensityState(d);
    window.dispatchEvent(new Event(DENSITY_EVENT));
  }, []);

  const setLayout = useCallback(
    (l: Layout) => {
      try {
        localStorage.setItem(`aura-view:${pageKey}`, l);
      } catch {
        /* ignore */
      }
      setLayoutState(l);
    },
    [pageKey],
  );

  return { density, setDensity, layout, setLayout };
}
