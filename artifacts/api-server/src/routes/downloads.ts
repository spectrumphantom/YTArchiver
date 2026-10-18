import { Router } from "express";
import {
  startDownloadJob,
  getJobStatus,
  requestStop,
  requestPause,
} from "../lib/downloader";
import { readManifest } from "../lib/manifest";

const router = Router();

router.post("/downloads/song/:id", async (req, res) => {
  try {
    if (getJobStatus().running) {
      res.status(409).json({ error: "A download is already running. Wait for it to finish or stop it first." });
      return;
    }
    const manifest = await readManifest();
    if (!manifest.songs[req.params.id]) {
      res.status(404).json({ error: "Song not found" });
      return;
    }
    await startDownloadJob([req.params.id]);
    res.json(getJobStatus());
  } catch (err) {
    req.log.error({ err }, "Failed to download song");
    res.status(500).json({ error: "Failed to start song download" });
  }
});

router.post("/downloads/start", async (req, res) => {
  try {
    await startDownloadJob();
    res.json(getJobStatus());
  } catch (err) {
    req.log.error({ err }, "Failed to start downloads");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to start downloads" });
  }
});

router.get("/downloads/status", (_req, res) => {
  res.json(getJobStatus());
});

router.post("/downloads/pause", async (req, res) => {
  try {
    await requestPause();
    res.json(getJobStatus());
  } catch (err) {
    req.log.error({ err }, "Failed to persist pause");
    res.status(500).json({ error: "Unable to save paused downloads" });
  }
});

router.post("/downloads/stop", async (req, res) => {
  try {
    await requestStop();
    res.json(getJobStatus());
  } catch (err) {
    req.log.error({ err }, "Failed to persist stop");
    res.status(500).json({ error: "Unable to save stopped downloads" });
  }
});

export default router;
