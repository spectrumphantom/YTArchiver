import { setTimeout as wait } from "node:timers/promises";
import { runYtDlp } from "./ytdlp";
import { logger } from "./logger";

export function normalizePlaylistUrl(input: string): string {
  const url = new URL(input);
  const list = url.searchParams.get("list");
  if (!list) return input;
  // Music and watch/share links address the same playlist. Drop tracking,
  // radio/recommendation flags and video offsets, keeping its exact list ID.
  const canonical = new URL("https://www.youtube.com/playlist");
  canonical.searchParams.set("list", list);
  return canonical.toString();
}

export async function extractPlaylistMetadata(input: string, io = {
  run: runYtDlp,
  wait: (ms: number) => wait(ms),
}): Promise<string> {
  const url = normalizePlaylistUrl(input);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { stdout, stderr } = await io.run([
        "--flat-playlist",
        "--print",
        "%(id)s\t%(title)s\t%(uploader,channel)s\t%(duration)s\t%(thumbnail)s\t%(playlist_title)s",
        "--no-warnings",
        "--ignore-errors",
        "--sleep-requests", "0.5",
        url,
      ], 10 * 60 * 1000);
      // --ignore-errors can exit successfully after a failed continuation.
      // Never replace the current playlist with a silently truncated listing.
      if (/(?:ERROR:|Unable to download API page)/i.test(stderr ?? "")) {
        throw new Error(stderr);
      }
      return stdout;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/403|forbidden|429|too many requests/i.test(message)) throw err;
      if (attempt === 2) {
        throw new Error(
          `YouTube refused to list this playlist from this server after 3 attempts (HTTP ${/429|too many requests/i.test(message) ? "429" : "403"}). ` +
          "Your saved playlist was not changed. Please try again later; updating or retrying cannot guarantee access when YouTube blocks the server.",
        );
      }
      logger.warn({ attempt: attempt + 1 }, "YouTube refused playlist listing; retrying with backoff");
      await io.wait(attempt === 0 ? 1500 : 4000);
    }
  }
  throw new Error("Playlist extraction did not complete");
}
