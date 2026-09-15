import { Router, type IRouter } from "express";
import healthRouter from "./health";
import comparisonsRouter from "./comparisons";
import commercialRouter from "./commercial";
import managementRouter from "./management";

const router: IRouter = Router();

router.use(healthRouter);
router.use(comparisonsRouter);
router.use(commercialRouter);
router.use(managementRouter);

export default router;
