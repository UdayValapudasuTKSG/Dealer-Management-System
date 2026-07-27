import app from "./app";
import { logger } from "./lib/logger";
import { startEmailWorker } from "./lib/email";
import { startGmailIntakeWorker } from "./lib/gmail-intake";
import { startAdvanceProposalWorker } from "./lib/advance-proposals";
import { startNotificationSweeps } from "./lib/notification-sweeps";
import { startRetentionSweeps } from "./lib/retention-sweeps";
import { migrateLegacyAttachments } from "./lib/documents-migrate";
import { startMetricsFlusher } from "./lib/metrics";
import { logPendingInfraSeams } from "./lib/infra-seams";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startEmailWorker();
  startGmailIntakeWorker();
  startAdvanceProposalWorker();
  startNotificationSweeps();
  startRetentionSweeps();
  void migrateLegacyAttachments();
  startMetricsFlusher();
  logPendingInfraSeams();
});
