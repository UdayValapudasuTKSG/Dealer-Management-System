import { Router, type IRouter } from "express";
import healthRouter from "./health";
import vehiclesRouter from "./vehicles";
import bookingsRouter from "./bookings";
import deliveriesRouter from "./deliveries";
import leadsRouter from "./leads";
import customersRouter from "./customers";
import dealsRouter from "./deals";
import appraisalsRouter from "./appraisals";
import financeRouter from "./finance";
import serviceRouter from "./service";
import partsRouter from "./parts";
import agentsRouter from "./agents";
import activityRouter from "./activity";
import dashboardRouter from "./dashboard";
import timelineRouter from "./timeline";
import gatesRouter from "./gates";
import anthropicRouter from "./anthropic";
import copilotkitRouter from "./copilotkit";
import graRouter from "./gra";
import pipelineRouter from "./pipeline";
import authRouter from "./auth";
import adminRouter from "./admin";
import auditRouter from "./audit";
import emailsRouter from "./emails";
import notificationsRouter from "./notifications";
import tasksRouter from "./tasks";
import communicationsRouter from "./communications";
import reportsRouter from "./reports";
import searchRouter from "./search";
import enquiriesRouter from "./enquiries";
import webhooksRouter from "./webhooks";
import testDriveRouter from "./test-drive";
import { requireAuth, authorize, auditTrail } from "../middlewares/rbac";

const router: IRouter = Router();

// Public: health check, website enquiry intake and inbound lead webhooks
// (Meta Lead Ads + Twilio WhatsApp — signature-verified, not session-authed).
router.use(healthRouter);
router.use(enquiriesRouter);
router.use(webhooksRouter);
// Public: customer self-service test-drive booking (token-authenticated link).
router.use(testDriveRouter);

// Everything below requires a signed-in user, then a role permission
// matching the route (see middlewares/rbac.ts), and mutations are audited.
router.use(requireAuth);
router.use(authorize);
router.use(auditTrail);

router.use(authRouter);
router.use(adminRouter);
router.use(auditRouter);
router.use(vehiclesRouter);
router.use(bookingsRouter);
router.use(deliveriesRouter);
router.use(leadsRouter);
router.use(customersRouter);
router.use(dealsRouter);
router.use(appraisalsRouter);
router.use(financeRouter);
router.use(serviceRouter);
router.use(partsRouter);
router.use(agentsRouter);
router.use(activityRouter);
router.use(dashboardRouter);
router.use(timelineRouter);
router.use(gatesRouter);
router.use(anthropicRouter);
router.use(copilotkitRouter);
router.use(graRouter);
router.use(pipelineRouter);
router.use(emailsRouter);
router.use(notificationsRouter);
router.use(tasksRouter);
router.use(communicationsRouter);
router.use(reportsRouter);
router.use(searchRouter);

export default router;
