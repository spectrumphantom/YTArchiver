import { Router } from "express";
import {
  startDownloadJob,
  getJobStatus,
  requestStop,
  requestPause,
} from "../lib/downloader";

const router = Router();

router.post("/downloads/start", async (req, res) => {
  try {
    await startDownloadJob();
    res.json(getJobStatus());
  } catch (err) {
    req.log.error({ err }, "Failed to start downloads");
    res.status(500).json({ error: "Failed to start downloads" });
  }
});

router.get("/downloads/status", (_req, res) => {
  res.json(getJobStatus());
});

router.post("/downloads/pause", (_req, res) => {
  requestPause();
  res.json(getJobStatus());
});

router.post("/downloads/stop", (_req, res) => {
  requestStop();
  res.json(getJobStatus());
});

export default router;
