import type { RequestHandler } from "express";
import { incrementMetric } from "../lib/metrics";

// ---------------------------------------------------------------------------
// In-memory sliding-window rate limiting. Two tiers:
//  - authedRateLimit: per authenticated user (falls back to IP), generous —
//    protects the API from runaway clients and scripted abuse.
//  - publicRateLimit: per IP, tight — for unauthenticated webhook/enquiry
//    endpoints exposed to the internet.
// Single-process by design; a shared store (Redis) is only needed if the API
// ever scales horizontally (see infra-seams / message broker).
// ---------------------------------------------------------------------------

type Bucket = { count: number; windowStart: number };

function makeLimiter(opts: {
  windowMs: number;
  max: number;
  keyFor: (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) => string;
  scope: string;
}): RequestHandler {
  const buckets = new Map<string, Bucket>();

  // Periodic sweep so the map cannot grow without bound.
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - opts.windowMs;
    for (const [k, b] of buckets) {
      if (b.windowStart < cutoff) buckets.delete(k);
    }
  }, opts.windowMs);
  sweeper.unref?.();

  return (req, res, next) => {
    const key = opts.keyFor(req, res);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart >= opts.windowMs) {
      bucket = { count: 0, windowStart: now };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const remaining = Math.max(0, opts.max - bucket.count);
    res.setHeader("RateLimit-Limit", String(opts.max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    if (bucket.count > opts.max) {
      const retryAfterSec = Math.ceil(
        (bucket.windowStart + opts.windowMs - now) / 1000,
      );
      res.setHeader("Retry-After", String(Math.max(1, retryAfterSec)));
      incrementMetric("rate_limited_total", { scope: opts.scope });
      res.status(429).json({ error: "Too many requests — slow down and retry shortly" });
      return;
    }
    next();
  };
}

/** 600 requests / minute per signed-in user (per dealer context). */
export const authedRateLimit: RequestHandler = makeLimiter({
  windowMs: 60_000,
  max: 600,
  scope: "authed",
  keyFor: (req, res) =>
    res.locals.user ? `u:${res.locals.user.id}:${res.locals.dealerId ?? 0}` : `ip:${req.ip}`,
});

/** 60 requests / minute per IP for public (unauthenticated) endpoints. */
export const publicRateLimit: RequestHandler = makeLimiter({
  windowMs: 60_000,
  max: 60,
  scope: "public",
  keyFor: (req) => `ip:${req.ip}`,
});
