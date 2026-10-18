import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { objectStorageClient } from "./objectStorage";
import { readManifest, mutateManifest, updateSong, getPlaylistSongs, type Song, type Manifest } from "./manifest";
import { runYtDlp } from "./ytdlp";
import { logger } from "./logger";
import { randomUUID } from "node:crypto";
import { describeDownloadError } from "./downloadErrors";
import type { SavedDownloadJob } from "./manifest";

const AUDIO_PREFIX = "playlist-downloader/audio";

function sanitizeFilename(title: string): string {
  return (
    title
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .replace(/\s+/g, "_")
      .replace(/_{2,}/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 100) || "unknown"
  );
}

export type JobState = "idle" | "running" | "paused";

export interface DownloadJobStatus {
  running: boolean;
  state: JobState;
  currentSong: string | null;
  pending: number;
  completed: number;
  failed: number;
}

let jobStatus: DownloadJobStatus = {
  running: false,
  state: "idle",
  currentSong: null,
  pending: 0,
  completed: 0,
  failed: 0,
};

let stopRequested = false;
let pauseRequested = false;
let currentAbort: AbortController | null = null;

export function getJobStatus(): DownloadJobStatus {
  return { ...jobStatus };
}

export async function requestStop(): Promise<void> {
  stopRequested = true;
  currentAbort?.abort();
  await mutateManifest((manifest) => {
    if (manifest.downloadJob) manifest.downloadJob.state = "stopped";
  });
  if (!jobStatus.running) {
    jobStatus.state = "idle";
    jobStatus.pending = 0;
  }
}

export async function requestPause(): Promise<void> {
  if (!jobStatus.running) return;
  pauseRequested = true;
  await mutateManifest((manifest) => {
    if (manifest.downloadJob) manifest.downloadJob.state = "paused";
  });
}

function getBucketId(): string {
  const id = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  if (!id) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");
  return id;
}

export async function scrapePlaylist(url: string): Promise<{
  totalFound: number;
  newAdded: number;
  alreadyExists: number;
  playlistTitle: string;
  songs: Song[];
}> {
  const { stdout: output } = await runYtDlp(
    [
      "--flat-playlist",
      "--print",
      "%(id)s\t%(title)s\t%(uploader,channel)s\t%(duration)s\t%(thumbnail)s\t%(playlist_title)s",
      "--no-warnings",
      "--ignore-errors",
      "--sleep-requests", "0.5",
      url,
    ],
    10 * 60 * 1000
  );

  const lines = output
    .trim()
    .split("\n")
    .filter((l) => l.includes("\t"));

  if (lines.length === 0) {
    throw new Error(
      "No videos found. Make sure the playlist is public and the URL is correct."
    );
  }

  const { manifest, result } = await mutateManifest((manifest) => {
    let newAdded = 0;
    let alreadyExists = 0;
    let playlistTitle = "";
    const playlistSongIds: string[] = [];

    for (const line of lines) {
      const parts = line.split("\t");
      const [id, title, channel, durationStr, thumbnailUrl, plTitle] = parts;
      if (!id || !title || title === "[Private video]" || title === "[Deleted video]") continue;
      if (playlistSongIds.includes(id)) continue;
      playlistSongIds.push(id);

      if (!playlistTitle && plTitle && plTitle !== "NA" && plTitle !== "None") {
        playlistTitle = plTitle;
      }

      if (manifest.songs[id]) {
        alreadyExists++;
        const existing = manifest.songs[id];
        existing.title = title;
        if (channel && channel !== "NA" && channel !== "None") existing.channel = channel;
        const duration = Math.round(parseFloat(durationStr || "0")) || 0;
        if (duration > 0) existing.duration = duration;
        if (thumbnailUrl && thumbnailUrl !== "NA" && thumbnailUrl !== "None") existing.thumbnailUrl = thumbnailUrl;
        continue;
      }

      const song: Song = {
        id,
        title: title || "Unknown",
        channel: channel && channel !== "NA" && channel !== "None" ? channel : "Unknown",
        duration: Math.round(parseFloat(durationStr || "0")) || 0,
        thumbnailUrl:
          thumbnailUrl && thumbnailUrl !== "NA" && thumbnailUrl !== "None"
            ? thumbnailUrl
            : null,
        status: "pending",
        bucketPath: null,
        addedAt: new Date().toISOString(),
        downloadedAt: null,
      };

      manifest.songs[id] = song;
      newAdded++;
    }

    if (playlistSongIds.length === 0) throw new Error("No playable videos were found in this playlist.");
    manifest.playlistTitle = playlistTitle || "YouTube Playlist";
    manifest.playlistSongIds = playlistSongIds;
    manifest.playlistUrl = url;
    return { newAdded, alreadyExists };
  });

  return {
    totalFound: lines.length,
    newAdded: result.newAdded,
    alreadyExists: result.alreadyExists,
    playlistTitle: manifest.playlistTitle || "YouTube Playlist",
    songs: getPlaylistSongs(manifest),
  };
}

/**
 * Make each song's status match what is really in storage.
 * - "done" without its audio file  -> pending (will be downloaded again)
 * - not "done" but audio exists     -> done (e.g. crash after upload)
 * - stuck "downloading" with no job -> pending
 * Active downloads are preserved; a finished upload wins over an older status.
 */
export async function reconcileSongStatuses(): Promise<number> {
  const scanStartedAt = Date.now();
  const [files] = await objectStorageClient.bucket(getBucketId()).getFiles({ prefix: `${AUDIO_PREFIX}/` });
  const names = new Set(files
    .filter((file) => /\.(mp3|m4a|opus|webm)$/i.test(file.name) && Number(file.metadata.size) > 0)
    .map((file) => file.name));
  const byId = new Map<string, string>();
  for (const name of names) {
    const match = /_\[([^\]]+)\]\.[A-Za-z0-9]+$/.exec(name);
    if (match) byId.set(match[1], name);
  }
  const reconcile = (manifest: Manifest) => {
    let fixed = 0;
    const activeIds = new Set(manifest.downloadJob?.state === "running" ? manifest.downloadJob.remainingIds : []);
    for (const song of Object.values(manifest.songs)) {
      // The listing may predate a concurrent upload. Never undo its new status.
      if (song.downloadedAt && Date.parse(song.downloadedAt) >= scanStartedAt) continue;
      const existing = song.bucketPath && names.has(song.bucketPath)
        ? song.bucketPath
        : byId.get(song.id);
      if (existing) {
        if (song.status !== "done" || song.bucketPath !== existing || !song.downloadedAt || song.errorReason || song.errorDetails) {
          song.status = "done";
          song.bucketPath = existing;
          song.downloadedAt = song.downloadedAt ?? new Date().toISOString();
          song.errorReason = null;
          song.errorDetails = null;
          fixed++;
        }
      } else if (song.status === "done" || (song.status === "downloading" && !activeIds.has(song.id))) {
        song.status = "pending";
        song.bucketPath = null;
        song.downloadedAt = null;
        fixed++;
      } else if (song.bucketPath || song.downloadedAt) {
        // Incomplete/error records must not retain metadata claiming completion.
        song.bucketPath = null;
        song.downloadedAt = null;
        fixed++;
      }
    }
    return fixed;
  };
  // Avoid rewriting the entire shared manifest when nothing needs correcting.
  if (reconcile(await readManifest()) === 0) return 0;
  const { result } = await mutateManifest(reconcile);
  if (result > 0) logger.info({ fixed: result }, "Corrected song statuses to match storage");
  return result;
}

let statusRefresh: Promise<void> | null = null;
let lastStatusRefresh = 0;

/** Keep list/detail/stats responses verified without listing storage per song. */
export async function refreshSongStatuses(): Promise<void> {
  if (statusRefresh) return statusRefresh;
  if (Date.now() - lastStatusRefresh < 5000) return;
  statusRefresh = reconcileSongStatuses()
    .then(() => { lastStatusRefresh = Date.now(); })
    .finally(() => { statusRefresh = null; });
  return statusRefresh;
}

/** Stop any running download and remove the current playlist from the list. */
export async function clearPlaylist(): Promise<void> {
  stopRequested = true;
  currentAbort?.abort();
  for (let i = 0; jobStatus.running && i < 300; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (jobStatus.running) throw new Error("The running download did not stop in time. Try again.");
  await mutateManifest((manifest) => {
    manifest.playlistSongIds = [];
    manifest.playlistTitle = "";
    delete manifest.playlistUrl;
    delete manifest.downloadJob;
    for (const song of Object.values(manifest.songs)) {
      if (song.status === "downloading") song.status = "pending";
    }
  });
  jobStatus = { running: false, state: "idle", currentSong: null, pending: 0, completed: 0, failed: 0 };
}

// null = yt-dlp's default clients.
const FALLBACK_CLIENTS: (string | null)[] = [null, "web_embedded", "tv_simply", "android"];

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

async function downloadSingleSong(song: Song, signal?: AbortSignal): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-"));
  try {
    await updateSong(song.id, { status: "downloading", errorReason: null, errorDetails: null });

    // Some videos return HTTP 403 for the default player client's stream URLs
    // while other clients can fetch them. Try the default first, then fall back.
    let lastError: unknown;
    for (const client of FALLBACK_CLIENTS) {
      try {
        for (const leftover of await fs.readdir(tmpDir)) {
          await fs.rm(path.join(tmpDir, leftover), { recursive: true, force: true });
        }
        await runYtDlp(
          [
            "-x",
            "--audio-format", "mp3",
            "--audio-quality", "192K",
            "--output", path.join(tmpDir, "%(id)s.%(ext)s"),
            "--no-playlist",
            "--no-warnings",
            "--js-runtimes", "node",
            ...(client ? ["--extractor-args", `youtube:player_client=${client}`] : []),
            "--sleep-interval", "1",
            "--max-sleep-interval", "3",
            `https://www.youtube.com/watch?v=${song.id}`,
          ],
          15 * 60 * 1000,
          signal
        );
        lastError = undefined;
        if (client) logger.info({ id: song.id, client }, "Downloaded using fallback YouTube client");
        break;
      } catch (err) {
        lastError = err;
        if (isAbortError(err) || !/HTTP Error 403|Forbidden/i.test(String(err instanceof Error ? err.message : err))) throw err;
        logger.warn({ id: song.id, client: client ?? "default" }, "YouTube returned 403; trying another client");
      }
    }
    if (lastError) throw lastError;

    const files = await fs.readdir(tmpDir);
    const audioFile = files.find(
      (f) =>
        f.endsWith(".mp3") ||
        f.endsWith(".m4a") ||
        f.endsWith(".opus") ||
        f.endsWith(".webm")
    );
    if (!audioFile) throw new Error("No audio file produced");

    const localPath = path.join(tmpDir, audioFile);
    const { size } = await fs.stat(localPath);
    if (size === 0) throw new Error("The audio file is empty; the song is not finished.");
    const ext = path.extname(audioFile);
    const safeName = sanitizeFilename(song.title);
    const bucketPath = `${AUDIO_PREFIX}/${safeName}_[${song.id}]${ext}`;

    const bucket = objectStorageClient.bucket(getBucketId());
    await bucket.upload(localPath, {
      destination: bucketPath,
      metadata: { contentType: ext === ".mp3" ? "audio/mpeg" : "audio/mp4" },
    });

    await updateSong(song.id, {
      status: "done",
      bucketPath,
      downloadedAt: new Date().toISOString(),
      errorReason: null,
      errorDetails: null,
    });
    logger.info({ id: song.id, title: song.title }, "Song downloaded");
  } catch (err) {
    if (isAbortError(err)) {
      logger.info({ id: song.id }, "Download aborted, resetting to pending");
      await updateSong(song.id, { status: "pending", bucketPath: null, downloadedAt: null });
    } else {
      logger.error({ err, id: song.id }, "Failed to download song");
      await updateSong(song.id, { status: "error", bucketPath: null, downloadedAt: null, ...describeDownloadError(err) });
    }
    throw err;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

let starting = false;

export async function startDownloadJob(songIds?: string[], restore = false): Promise<void> {
  if (jobStatus.running || starting) throw new Error("A download is already running. Pause or stop it before starting another.");
  starting = true;
  let saved: SavedDownloadJob;
  let pending: Song[];
  try {
    await reconcileSongStatuses();
    const { result } = await mutateManifest((manifest) => {
      const previous = manifest.downloadJob;
      const resume = !songIds && previous && (restore || previous.state === "paused");
      const ids = songIds ?? (resume ? previous.remainingIds : getPlaylistSongs(manifest).map((song) => song.id));
      const songs = [...new Set(ids)].map((id) => manifest.songs[id]).filter((song): song is Song => Boolean(song) && song.status !== "done");
      for (const song of songs) {
        song.status = "pending";
        song.errorReason = null;
        song.errorDetails = null;
      }
      const job: SavedDownloadJob = {
        id: resume ? previous.id : randomUUID(),
        state: "running",
        remainingIds: songs.map((song) => song.id),
        completed: resume ? previous.completed : 0,
        failed: resume ? previous.failed : 0,
      };
      manifest.downloadJob = job;
      return { job, songs };
    });
    saved = result.job;
    pending = result.songs;
  } finally {
    starting = false;
  }
  stopRequested = false;
  pauseRequested = false;
  jobStatus = {
    running: true,
    state: "running",
    currentSong: null,
    pending: pending.length,
    completed: saved.completed,
    failed: saved.failed,
  };

  (async () => {
    try {
      for (const song of pending) {
        if (stopRequested || pauseRequested) break;
        jobStatus.currentSong = song.title;
        currentAbort = new AbortController();
        try {
          await downloadSingleSong(song, currentAbort.signal);
          jobStatus.completed++;
        } catch (err) {
          if (!isAbortError(err)) jobStatus.failed++;
        } finally {
          currentAbort = null;
        }
        // An aborted song remains queued; a crash after upload is skipped on recovery.
        await mutateManifest((manifest) => {
          const job = manifest.downloadJob;
          if (!job || job.id !== saved.id) throw new Error("Download checkpoint changed unexpectedly");
          if (manifest.songs[song.id]?.status !== "pending") {
            job.remainingIds = job.remainingIds.filter((id) => id !== song.id);
          }
          job.completed = jobStatus.completed;
          job.failed = jobStatus.failed;
          jobStatus.pending = job.remainingIds.length;
        });
      }
    } catch (err) {
      logger.error({ err }, "Download job failed");
      pauseRequested = true;
    } finally {
      try {
        await mutateManifest((manifest) => {
          const job = manifest.downloadJob;
          if (!job || job.id !== saved.id) return;
          job.state = stopRequested ? "stopped" : pauseRequested || job.remainingIds.length ? "paused" : "completed";
        });
      } catch (err) {
        logger.error({ err }, "Could not checkpoint download job");
        pauseRequested = true;
      }
      jobStatus.running = false;
      jobStatus.state = pauseRequested && !stopRequested ? "paused" : "idle";
      jobStatus.currentSong = null;
      currentAbort = null;
    }
  })();
}

export async function recoverDownloadJob(): Promise<void> {
  try {
    await reconcileSongStatuses();
  } catch (err) {
    logger.error({ err }, "Could not verify song statuses against storage at startup");
  }
  const manifest = await readManifest();
  const saved = manifest.downloadJob;
  if (!saved) return;
  if (saved.state === "running") {
    logger.info({ remaining: saved.remainingIds.length }, "Resuming interrupted download job");
    await startDownloadJob(undefined, true);
  } else if (saved.state === "paused") {
    jobStatus = { running: false, state: "paused", currentSong: null, pending: saved.remainingIds.length, completed: saved.completed, failed: saved.failed };
  }
}
