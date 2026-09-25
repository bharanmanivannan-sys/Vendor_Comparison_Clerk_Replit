import { Router, type IRouter } from "express";
import healthRouter from "./health";
import comparisonsRouter from "./comparisons";
import commercialRouter from "./commercial";
import managementRouter from "./management";
import quotesRouter from "./quotes";
import verificationRouter from "./verification";

const router: IRouter = Router();

router.use(healthRouter);
router.use(comparisonsRouter);
router.use(verificationRouter);
router.use(quotesRouter);
router.use(commercialRouter);
router.use(managementRouter);

export default router;
