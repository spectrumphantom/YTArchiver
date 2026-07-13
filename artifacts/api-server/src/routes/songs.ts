import { Router } from "express";
import path from "path";
import { readManifest } from "../lib/manifest";
import { objectStorageClient } from "../lib/objectStorage";

const router = Router();

function getBucketId(): string {
  const id = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  if (!id) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");
  return id;
}

router.get("/songs", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const pageSize = Math.min(
      200,
      Math.max(1, parseInt(String(req.query.pageSize ?? "50"), 10) || 50)
    );

    const sortParam = String(req.query.sort ?? "added");
    const sort = ["added", "title", "channel"].includes(sortParam)
      ? (sortParam as "added" | "title" | "channel")
      : "added";

    const manifest = await readManifest();
    const all = Object.values(manifest.songs).sort((a, b) => {
      switch (sort) {
        case "title":
          return a.title.localeCompare(b.title, undefined, {
            numeric: true,
            sensitivity: "base",
          });
        case "channel":
          return (
            a.channel.localeCompare(b.channel, undefined, {
              numeric: true,
              sensitivity: "base",
            }) ||
            a.title.localeCompare(b.title, undefined, {
              numeric: true,
              sensitivity: "base",
            })
          );
        default:
          return new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime();
      }
    });

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

router.get("/songs/:id/download", async (req, res) => {
  try {
    const manifest = await readManifest();
    const song = manifest.songs[req.params.id];
    if (!song || song.status !== "done" || !song.bucketPath) {
      res.status(404).json({ error: "Song not downloaded yet" });
      return;
    }

    const bucket = objectStorageClient.bucket(getBucketId());
    const file = bucket.file(song.bucketPath);
    const [exists] = await file.exists();
    if (!exists) {
      res.status(404).json({ error: "Audio file not found in storage" });
      return;
    }

    const ext = path.extname(song.bucketPath) || ".mp3";
    const safeTitle = song.title
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 100);
    const filename = `${safeTitle}${ext}`;

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    res.setHeader(
      "Content-Type",
      ext === ".mp3" ? "audio/mpeg" : "audio/mp4"
    );

    file.createReadStream().pipe(res);
  } catch (err) {
    req.log.error({ err, id: req.params.id }, "Failed to download song");
    res.status(500).json({ error: "Failed to stream audio file" });
  }
});

export default router;
