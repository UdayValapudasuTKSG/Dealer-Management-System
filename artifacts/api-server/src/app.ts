import express, {
  type ErrorRequestHandler,
  type Express,
} from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          // Customer portal bearer tokens live in the path. Never copy the
          // raw token into request logs.
          url: req.url
            ?.split("?")[0]
            ?.replace(/(\/collision-portal\/)[^/]+/i, "$1[redacted]"),
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Clerk proxy must be mounted before body parsers — it streams raw bytes.
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(cors({ credentials: true, origin: true }));

// CopilotKit's v2 runtime handler reads the raw request stream itself (it
// bridges to a fetch Request). Skip Express body-parsing for that path, or
// the parser drains the stream and the runtime hangs.
const jsonParser = express.json();
const urlencodedParser = express.urlencoded({ extended: true });
const isCopilotKit = (url: string): boolean =>
  url.startsWith("/api/copilotkit");
// Meta webhook signatures (Lead Ads + WhatsApp Cloud API) are HMAC over the
// exact raw bytes — keep the raw body for those paths.
const isMetaWebhook = (url: string): boolean =>
  url.startsWith("/api/webhooks/meta") ||
  url.startsWith("/api/webhooks/whatsapp") ||
  // Amber Connect webhook signature is HMAC over the exact raw bytes too.
  url.startsWith("/api/webhooks/amber");
const rawParser = express.raw({ type: "*/*", limit: "1mb" });
// GRA document extraction posts a base64 image in the JSON body — needs a
// larger limit than the 100kb express default.
const largeJsonParser = express.json({ limit: "12mb" });
const isGraExtract = (url: string): boolean =>
  url.startsWith("/api/gra/extract");

app.use((req, res, next) => {
  if (isCopilotKit(req.originalUrl)) return next();
  if (isMetaWebhook(req.originalUrl)) return rawParser(req, res, next);
  if (isGraExtract(req.originalUrl)) return largeJsonParser(req, res, next);
  jsonParser(req, res, next);
});
app.use((req, res, next) => {
  if (isCopilotKit(req.originalUrl) || isMetaWebhook(req.originalUrl))
    return next();
  urlencodedParser(req, res, next);
});

// Resolve the publishable key from the incoming request host so the same
// server can serve multiple Clerk custom domains. Falls back to
// CLERK_PUBLISHABLE_KEY when the host doesn't map to a custom domain.
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env["CLERK_PUBLISHABLE_KEY"],
    ),
  })),
);

app.use("/api", router);

type PgFailure = {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
};

/** Drizzle may retain the PostgreSQL error beneath one or more `cause`s. */
function pgFailure(error: unknown): { code?: string; constraint?: string } {
  let candidate: PgFailure | undefined =
    error && typeof error === "object" ? error as PgFailure : undefined;
  for (let depth = 0; candidate && depth < 4; depth += 1) {
    if (typeof candidate.code === "string") {
      return {
        code: candidate.code,
        constraint:
          typeof candidate.constraint === "string" ? candidate.constraint : undefined,
      };
    }
    candidate =
      candidate.cause && typeof candidate.cause === "object"
        ? candidate.cause as PgFailure
        : undefined;
  }
  return {};
}

// Database triggers are the final concurrency authority for job-card timers.
// Translate their intentionally-raised PostgreSQL errors here so a racing
// client gets an actionable response instead of an Express 500.
const jobCardTimerDatabaseErrors: ErrorRequestHandler = (error, _req, res, next) => {
  const failure = pgFailure(error);
  if (
    failure.code === "23505" &&
    failure.constraint === "job_cards_one_running_timer_per_technician"
  ) {
    res.status(409).json({
      error: "This technician already has a running job-card timer. Pause or stop that work before starting another card.",
    });
    return;
  }
  if (
    failure.code === "23514" &&
    failure.constraint === "job_cards_running_timer_technician_required"
  ) {
    res.status(422).json({
      error: "Assign a technician before starting the job-card timer.",
    });
    return;
  }
  next(error);
};
app.use(jobCardTimerDatabaseErrors);

export default app;
