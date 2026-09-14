import { Router, type IRouter } from "express";
import healthRouter from "./health";
import vehiclesRouter from "./vehicles";
import bookingsRouter from "./bookings";
import deliveriesRouter from "./deliveries";
import deliveryImportsRouter from "./delivery-imports";
import leadsRouter from "./leads";
import customersRouter from "./customers";
import dealsRouter from "./deals";
import appraisalsRouter from "./appraisals";
import financeRouter from "./finance";
import vehicleModelGlCodesRouter from "./vehicle-model-gl-codes";
import serviceRouter from "./service";
import collisionRouter from "./collision";
import partsRouter from "./parts";
import partRequisitionsRouter from "./part-requisitions";
import agentsRouter from "./agents";
import activityRouter from "./activity";
import dashboardRouter from "./dashboard";
import timelineRouter from "./timeline";
import gatesRouter from "./gates";
import capacityRouter from "./capacity";
import anthropicRouter from "./anthropic";
import copilotkitRouter from "./copilotkit";
import graRouter from "./gra";
import pipelineRouter from "./pipeline";
import sentimentRouter from "./sentiment";
import authRouter from "./auth";
import adminRouter from "./admin";
import divisionsRouter from "./divisions";
import platformRouter from "./platform";
import auditRouter from "./audit";
import emailsRouter from "./emails";
import calendarRouter from "./calendar";
import notificationsRouter from "./notifications";
import tasksRouter from "./tasks";
import communicationsRouter from "./communications";
import reportsRouter from "./reports";
import searchRouter from "./search";
import teamRouter from "./team";
import storageRouter from "./storage";
import documentsRouter from "./documents";
import enquiriesRouter from "./enquiries";
import webhooksRouter from "./webhooks";
import testDriveRouter from "./test-drive";
import feedbackRouter from "./feedback";
import vehicleOnboardingRouter from "./vehicle-onboarding";
import collisionPortalRouter from "./collision-portal";
import serviceEstimateRouter from "./service-estimate";
import feedbackFormsRouter from "./feedback-forms";
import testDrivesRouter from "./test-drives";
import reviewsRouter from "./reviews";
import casesRouter from "./cases";
import telephonyRouter from "./telephony";
import erpnextRouter from "./erpnext";
import amberRouter from "./amber";
import whatsappRouter from "./whatsapp";
import metaRouter from "./meta";
import { requireAuth, authorize, auditTrail } from "../middlewares/rbac";
import { authedRateLimit, publicRateLimit } from "../middlewares/rate-limit";

const router: IRouter = Router();

// Public: health check, website enquiry intake and inbound lead webhooks
// (Meta Lead Ads + Twilio WhatsApp — signature-verified, not session-authed).
// Tight per-IP rate limit — these are internet-exposed.
router.use(healthRouter);
// Scope the tight per-IP limit to the public prefixes ONLY. Mounting it with
// a bare router.use() would run it for EVERY request — and behind the shared
// reverse proxy all browser traffic presents the same IP, so the whole app
// would collapse into one 60/min bucket and 429 during normal browsing.
router.use("/enquiries", publicRateLimit);
router.use("/webhooks", publicRateLimit);
router.use("/test-drive", publicRateLimit);
router.use("/feedback", publicRateLimit);
router.use("/service-estimates", publicRateLimit);
router.use("/vehicle-onboarding", publicRateLimit);
router.use("/collision-portal", publicRateLimit);
router.use(enquiriesRouter);
router.use(webhooksRouter);
// Public: customer self-service test-drive booking (token-authenticated link).
router.use(testDriveRouter);
// Public: customer feedback form (token-authenticated link).
router.use(feedbackRouter);
router.use(serviceEstimateRouter);
router.use(vehicleOnboardingRouter);
router.use(collisionPortalRouter);

// Everything below requires a signed-in user, then a role permission
// matching the route (see middlewares/rbac.ts), and mutations are audited.
// A generous per-user rate limit guards against runaway clients.
// Pipeline order (R4.1): authn + dealer resolution (requireAuth) →
// tenant-status / RBAC / entitlement gate (authorize) → rate limit →
// idempotency + validation + resource scoping inside the route handlers.
router.use(requireAuth);
router.use(authorize);
router.use(authedRateLimit);
router.use(auditTrail);

router.use(authRouter);
router.use(platformRouter);
router.use(adminRouter);
router.use(divisionsRouter);
router.use(auditRouter);
router.use(vehiclesRouter);
router.use(bookingsRouter);
router.use(deliveriesRouter);
router.use(deliveryImportsRouter);
router.use(leadsRouter);
router.use(feedbackFormsRouter);
router.use(testDrivesRouter);
router.use(customersRouter);
router.use(reviewsRouter);
router.use(casesRouter);
router.use(dealsRouter);
router.use(appraisalsRouter);
router.use(financeRouter);
router.use(vehicleModelGlCodesRouter);
router.use(serviceRouter);
router.use(collisionRouter);
router.use(partsRouter);
router.use(partRequisitionsRouter);
router.use(agentsRouter);
router.use(activityRouter);
router.use(dashboardRouter);
router.use(sentimentRouter);
router.use(timelineRouter);
router.use(gatesRouter);
router.use(capacityRouter);
router.use(anthropicRouter);
router.use(copilotkitRouter);
router.use(graRouter);
router.use(pipelineRouter);
router.use(emailsRouter);
router.use(calendarRouter);
router.use(notificationsRouter);
router.use(tasksRouter);
router.use(communicationsRouter);
router.use(reportsRouter);
router.use(searchRouter);
router.use(teamRouter);
router.use(storageRouter);
router.use(documentsRouter);
router.use(telephonyRouter);
router.use(erpnextRouter);
router.use(amberRouter);
router.use(whatsappRouter);
router.use(metaRouter);

export default router;
