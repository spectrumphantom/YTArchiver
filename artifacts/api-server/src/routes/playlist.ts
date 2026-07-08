import { Router } from "express";
import { scrapePlaylist } from "../lib/downloader";
import { z } from "zod";

const router = Router();

const ScrapeInputSchema = z.object({
  url: z.string().min(1),
});

const ALLOWED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

function isValidYouTubeUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return false;
  }
  return ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
}

router.post("/playlist/scrape", async (req, res) => {
  const parsed = ScrapeInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request: url is required" });
    return;
  }

  const { url } = parsed.data;

  if (!isValidYouTubeUrl(url)) {
    res.status(400).json({ error: "URL must be a valid YouTube URL (https://www.youtube.com/... or https://youtu.be/...)" });
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
