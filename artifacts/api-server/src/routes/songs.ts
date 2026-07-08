import { Router } from "express";
import { readManifest } from "../lib/manifest";

const router = Router();

router.get("/songs", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const pageSize = Math.min(
      200,
      Math.max(1, parseInt(String(req.query.pageSize ?? "50"), 10) || 50)
    );

    const manifest = await readManifest();
    const all = Object.values(manifest.songs).sort(
      (a, b) => new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime()
    );

    const total = all.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const start = (page - 1) * pageSize;
    const songs = all.slice(start, start + pageSize);

    res.json({ songs, total, page, pageSize, totalPages });
  } catch (err) {
    req.log.error({ err }, "Failed to list songs");
    res.status(500).json({ error: "Failed to list songs" });
  }
});

router.get("/songs/stats", async (req, res) => {
  try {
    const manifest = await readManifest();
    const songs = Object.values(manifest.songs);
    const stats = {
      total: songs.length,
      downloaded: songs.filter((s) => s.status === "done").length,
      pending: songs.filter((s) => s.status === "pending").length,
      downloading: songs.filter((s) => s.status === "downloading").length,
      error: songs.filter((s) => s.status === "error").length,
    };
    res.json(stats);
  } catch (err) {
    req.log.error({ err }, "Failed to get stats");
    res.status(500).json({ error: "Failed to get stats" });
  }
});

export default router;
