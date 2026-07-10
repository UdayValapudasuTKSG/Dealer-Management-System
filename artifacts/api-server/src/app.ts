import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
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
app.use(cors());

// CopilotKit's runtime endpoint is served by GraphQL Yoga, which reads the raw
// request stream itself. Skip Express body-parsing for that path, or the parser
// drains the stream and Yoga hangs.
const jsonParser = express.json();
const urlencodedParser = express.urlencoded({ extended: true });
const isCopilotKit = (url: string): boolean =>
  url.startsWith("/api/copilotkit");

app.use((req, res, next) => {
  if (isCopilotKit(req.originalUrl)) return next();
  jsonParser(req, res, next);
});
app.use((req, res, next) => {
  if (isCopilotKit(req.originalUrl)) return next();
  urlencodedParser(req, res, next);
});

app.use("/api", router);

export default app;
