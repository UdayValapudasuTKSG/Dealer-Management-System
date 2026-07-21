import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Structured in-process metrics: counters + request duration accumulators,
// flushed to the structured log every 60s as a single `metrics` event so any
// log-based observability stack can graph them. When managed tracing /
// metrics infrastructure arrives, exportMetricsSnapshot() is the seam.
// ---------------------------------------------------------------------------

type Labels = Record<string, string>;

const counters = new Map<string, number>();
const durations = new Map<string, { count: number; totalMs: number; maxMs: number }>();

function seriesKey(name: string, labels?: Labels): string {
  if (!labels) return name;
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`);
  return `${name}{${parts.join(",")}}`;
}

export function incrementMetric(name: string, labels?: Labels, by = 1): void {
  const key = seriesKey(name, labels);
  counters.set(key, (counters.get(key) ?? 0) + by);
}

export function observeDuration(name: string, ms: number, labels?: Labels): void {
  const key = seriesKey(name, labels);
  const cur = durations.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
  cur.count += 1;
  cur.totalMs += ms;
  cur.maxMs = Math.max(cur.maxMs, ms);
  durations.set(key, cur);
}

export function exportMetricsSnapshot(): {
  counters: Record<string, number>;
  durations: Record<string, { count: number; avgMs: number; maxMs: number }>;
} {
  const c: Record<string, number> = {};
  for (const [k, v] of counters) c[k] = v;
  const d: Record<string, { count: number; avgMs: number; maxMs: number }> = {};
  for (const [k, v] of durations)
    d[k] = { count: v.count, avgMs: Math.round(v.totalMs / v.count), maxMs: Math.round(v.maxMs) };
  return { counters: c, durations: d };
}

const FLUSH_MS = 60_000;
let flushTimer: ReturnType<typeof setInterval> | null = null;

export function startMetricsFlusher(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (counters.size === 0 && durations.size === 0) return;
    logger.info({ metrics: exportMetricsSnapshot() }, "metrics flush");
    counters.clear();
    durations.clear();
  }, FLUSH_MS);
  flushTimer.unref?.();
}
