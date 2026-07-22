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

function isLoopbackAddr(ip: string | undefined): boolean {
  if (!ip) return false;
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip.startsWith("127.")
  );
}

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
    // Dev-only: loopback test-persona traffic (regression suites, curl checks)
    // is exempt so back-to-back suite runs don't starve each other — UNLESS the
    // request opts back in with `x-rate-limit-probe` (used by the flood test).
    if (
      process.env.NODE_ENV !== "production" &&
      req.headers["x-test-user-email"] &&
      !req.headers["x-rate-limit-probe"] &&
      isLoopbackAddr(req.ip)
    ) {
      next();
      return;
    }
    const key = opts.keyFor(req, res);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart >= opts.windowMs) {
      bucket = { count: 0, windowStart: now };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const remaining = Math.max(0, opts.max - bucket.count);
    const resetSec = Math.max(
      1,
      Math.ceil((bucket.windowStart + opts.windowMs - now) / 1000),
    );
    res.setHeader("RateLimit-Limit", String(opts.max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(resetSec));
    if (bucket.count > opts.max) {
      res.setHeader("Retry-After", String(resetSec));
      incrementMetric("rate_limited_total", { scope: opts.scope });
      res.status(429).json({
        error: "rate_limited",
        message: "Too many requests — slow down and retry shortly",
        retryAfter: resetSec,
      });
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
