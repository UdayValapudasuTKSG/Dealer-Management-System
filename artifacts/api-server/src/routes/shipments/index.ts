import { Router, type IRouter } from "express";
import allocations from "./allocations";
import imports from "./imports";
import matching from "./matching";
import core from "./core";

/**
 * Shipment allocation feature. Static paths (/shipments/specs, tracking,
 * exceptions, eligible-leads, allocations/*, imports/*, proposals/*) are
 * registered before the /shipments/:shipmentId routes in core.
 */
const router: IRouter = Router();
router.use(allocations);
router.use(imports);
router.use(matching);
router.use(core);
export default router;
