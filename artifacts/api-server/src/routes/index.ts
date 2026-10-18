import { Router, type IRouter } from "express";
import healthRouter from "./health";
import storageRouter from "./storage";
import playlistRouter from "./playlist";
import songsRouter from "./songs";
import downloadsRouter from "./downloads";
import accountRouter from "./account";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(accountRouter);
router.use(storageRouter);
router.use(requireAuth, playlistRouter, songsRouter, downloadsRouter);

export default router;
