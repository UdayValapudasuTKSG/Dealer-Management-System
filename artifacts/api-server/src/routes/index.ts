import { Router, type IRouter } from "express";
import healthRouter from "./health";
import vehiclesRouter from "./vehicles";
import leadsRouter from "./leads";
import customersRouter from "./customers";
import dealsRouter from "./deals";
import appraisalsRouter from "./appraisals";
import financeRouter from "./finance";
import serviceRouter from "./service";
import agentsRouter from "./agents";
import activityRouter from "./activity";
import dashboardRouter from "./dashboard";
import anthropicRouter from "./anthropic";

const router: IRouter = Router();

router.use(healthRouter);
router.use(vehiclesRouter);
router.use(leadsRouter);
router.use(customersRouter);
router.use(dealsRouter);
router.use(appraisalsRouter);
router.use(financeRouter);
router.use(serviceRouter);
router.use(agentsRouter);
router.use(activityRouter);
router.use(dashboardRouter);
router.use(anthropicRouter);

export default router;
