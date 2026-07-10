import { Router, type IRouter } from "express";
import {
  CopilotRuntime,
  AnthropicAdapter,
  copilotRuntimeNodeExpressEndpoint,
} from "@copilotkit/runtime";
import { anthropic } from "@workspace/integrations-anthropic-ai";

const router: IRouter = Router();

const serviceAdapter = new AnthropicAdapter({
  anthropic,
  model: "claude-sonnet-4-6",
});

const runtime = new CopilotRuntime();

const handler = copilotRuntimeNodeExpressEndpoint({
  endpoint: "/api/copilotkit",
  runtime,
  serviceAdapter,
});

router.use("/copilotkit", (req, res, next) => {
  req.url = req.originalUrl;
  // The runtime streams its response incrementally. Signal the Replit reverse
  // proxy (and any intermediary) not to buffer or transform the body, otherwise
  // the stream is cut and the browser sees ERR_INCOMPLETE_CHUNKED_ENCODING.
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  Promise.resolve(handler(req, res)).catch(next);
});

export default router;
