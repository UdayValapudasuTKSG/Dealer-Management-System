import { Router, type IRouter } from "express";
import {
  CopilotRuntime,
  BuiltInAgent,
  createCopilotExpressHandler,
} from "@copilotkit/runtime/v2";
import { createAnthropic } from "@ai-sdk/anthropic";
import { activeDealerId } from "../middlewares/rbac";
import { isAgentEnabled, recordAgentRun } from "../lib/agent-governance";

// The 1.62 web client speaks the v2 "single-route" envelope protocol
// (POST { method: "info" | "run" | ... } to the runtime URL). The legacy
// v1 GraphQL endpoint cannot answer those requests (every probe 400s with
// "Invalid JSON payload" and the UI shows a red runtime-error banner), so
// the server mounts the matching v2 runtime instead.
const anthropicProvider = createAnthropic({
  // The Anthropic SDK treats the base URL as the API root; the AI SDK
  // expects the versioned prefix included.
  baseURL: `${process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL}/v1`,
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
});

const runtime = new CopilotRuntime({
  agents: {
    // The client requests the agent named "default".
    default: new BuiltInAgent({
      model: anthropicProvider("claude-sonnet-4-6"),
      maxSteps: 5,
      prompt:
        "You are the AURA Concierge, the in-app assistant for an automotive dealership operating system. " +
        "Be concise and professional. Use the provided readable context (current page, live KPIs, pending decision gates) " +
        "to answer questions, and use the available frontend tools to navigate or open records when the user asks. " +
        "Never invent data that is not in the provided context.",
    }),
  },
});

const handler = createCopilotExpressHandler({
  runtime,
  basePath: "/api/copilotkit",
  mode: "single-route",
});

const router: IRouter = Router();

router.use("/copilotkit", async (req, res, next) => {
  // Concierge kill switch (R3): the in-app assistant is a governed HITL
  // agent — when paused for this dealer, the runtime is not reachable.
  const dealerId = activeDealerId(res);
  if (!(await isAgentEnabled(dealerId, "concierge"))) {
    await recordAgentRun({
      dealerId,
      agentKey: "concierge",
      runType: "chat_turn",
      inputSource: "copilotkit",
      status: "blocked",
      errorMessage: "Agent paused by kill switch",
    });
    res.status(409).json({
      error: "The Concierge assistant is paused for this dealership.",
    });
    return;
  }
  // Audit every runtime interaction (body is unparsed on this route, so the
  // run is recorded on response completion; failures land as "error").
  if (req.method === "POST") {
    const startedAt = Date.now();
    res.on("finish", () => {
      void recordAgentRun({
        dealerId,
        agentKey: "concierge",
        runType: "chat_turn",
        inputSource: "copilotkit",
        outputSummary: `Runtime request completed (HTTP ${res.statusCode})`,
        status: res.statusCode < 400 ? "completed" : "error",
        errorMessage:
          res.statusCode < 400 ? undefined : `HTTP ${res.statusCode}`,
        latencyMs: Date.now() - startedAt,
      }).catch(() => {});
    });
  }
  req.url = req.originalUrl;
  // The runtime streams its response incrementally. Signal the Replit reverse
  // proxy (and any intermediary) not to buffer or transform the body, otherwise
  // the stream is cut and the browser sees ERR_INCOMPLETE_CHUNKED_ENCODING.
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  handler(req, res, next);
});

export default router;
