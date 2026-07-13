import { Router, type IRouter } from "express";
import healthRouter from "./health";
import storageRouter from "./storage";
import playlistRouter from "./playlist";
import songsRouter from "./songs";
import downloadsRouter from "./downloads";
import authRouter from "./auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(storageRouter);
router.use(playlistRouter);
router.use(songsRouter);
router.use(downloadsRouter);

export default router;
