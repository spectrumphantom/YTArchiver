import { Router } from "express";
import { scrapePlaylist } from "../lib/downloader";
import { z } from "zod";

const router = Router();

const ScrapeInputSchema = z.object({
  url: z.string().min(1),
});

router.post("/playlist/scrape", async (req, res) => {
  const parsed = ScrapeInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request: url is required" });
    return;
  }

  const { url } = parsed.data;

  if (!url.includes("youtube.com") && !url.includes("youtu.be")) {
    res.status(400).json({ error: "URL must be a YouTube URL" });
    return;
  }

  try {
    const result = await scrapePlaylist(url);
    res.json(result);
  } catch (err: unknown) {
    req.log.error({ err }, "Scrape failed");
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: `Failed to scrape playlist: ${message}` });
  }
});

export default router;
