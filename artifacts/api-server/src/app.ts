import express, { type Express } from "express";
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
          url: req.url?.split("?")[0],
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
  url.startsWith("/api/webhooks/whatsapp");
const rawParser = express.raw({ type: "*/*", limit: "1mb" });

app.use((req, res, next) => {
  if (isCopilotKit(req.originalUrl)) return next();
  if (isMetaWebhook(req.originalUrl)) return rawParser(req, res, next);
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

export default app;
