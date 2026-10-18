import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { objectStorageClient } from "./objectStorage";
import { readManifest, mutateManifest, updateSong, getPlaylistSongs, type Song } from "./manifest";
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

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

async function downloadSingleSong(song: Song, signal?: AbortSignal): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-"));
  try {
    await updateSong(song.id, { status: "downloading", errorReason: null, errorDetails: null });

    await runYtDlp(
      [
        "-x",
        "--audio-format", "mp3",
        "--audio-quality", "192K",
        "--output", path.join(tmpDir, "%(id)s.%(ext)s"),
        "--no-playlist",
        "--no-warnings",
        "--sleep-interval", "1",
        "--max-sleep-interval", "3",
        `https://www.youtube.com/watch?v=${song.id}`,
      ],
      15 * 60 * 1000,
      signal
    );

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
    });
    logger.info({ id: song.id, title: song.title }, "Song downloaded");
  } catch (err) {
    if (isAbortError(err)) {
      logger.info({ id: song.id }, "Download aborted, resetting to pending");
      await updateSong(song.id, { status: "pending" });
    } else {
      logger.error({ err, id: song.id }, "Failed to download song");
      await updateSong(song.id, { status: "error", ...describeDownloadError(err) });
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
