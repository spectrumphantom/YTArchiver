import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { objectStorageClient } from "./objectStorage";
import { readManifest, mutateManifest, updateSong, type Song } from "./manifest";
import { runYtDlp } from "./ytdlp";
import { logger } from "./logger";

const AUDIO_PREFIX = "playlist-downloader/audio";

export interface DownloadJobStatus {
  running: boolean;
  currentSong: string | null;
  pending: number;
  completed: number;
  failed: number;
}

let jobStatus: DownloadJobStatus = {
  running: false,
  currentSong: null,
  pending: 0,
  completed: 0,
  failed: 0,
};

let stopRequested = false;

export function getJobStatus(): DownloadJobStatus {
  return { ...jobStatus };
}

export function requestStop(): void {
  stopRequested = true;
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

    for (const line of lines) {
      const parts = line.split("\t");
      const [id, title, channel, durationStr, thumbnailUrl, plTitle] = parts;
      if (!id || !title || title === "[Private video]" || title === "[Deleted video]") continue;

      if (!playlistTitle && plTitle && plTitle !== "NA" && plTitle !== "None") {
        playlistTitle = plTitle;
      }

      if (manifest.songs[id]) {
        alreadyExists++;
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

    if (playlistTitle) manifest.playlistTitle = playlistTitle;
    return { newAdded, alreadyExists };
  });

  return {
    totalFound: lines.length,
    newAdded: result.newAdded,
    alreadyExists: result.alreadyExists,
    playlistTitle: manifest.playlistTitle || "YouTube Playlist",
    songs: Object.values(manifest.songs),
  };
}

async function downloadSingleSong(song: Song): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-"));
  try {
    await updateSong(song.id, { status: "downloading" });

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
      15 * 60 * 1000
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
    const bucketPath = `${AUDIO_PREFIX}/${song.id}${ext}`;

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
    logger.error({ err, id: song.id }, "Failed to download song");
    await updateSong(song.id, { status: "error" });
    throw err;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export async function startDownloadJob(): Promise<void> {
  if (jobStatus.running) return;

  stopRequested = false;
  jobStatus = {
    running: true,
    currentSong: null,
    pending: 0,
    completed: 0,
    failed: 0,
  };

  (async () => {
    try {
      const manifest = await readManifest();
      const pending = Object.values(manifest.songs)
        .filter((s) => s.status === "pending" || s.status === "downloading" || s.status === "error")
        .sort((a, b) => new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime());

      jobStatus.pending = pending.length;

      for (const song of pending) {
        if (stopRequested) break;
        jobStatus.currentSong = song.title;
        try {
          await downloadSingleSong(song);
          jobStatus.completed++;
        } catch {
          jobStatus.failed++;
        }
        jobStatus.pending = Math.max(0, jobStatus.pending - 1);
      }
    } catch (err) {
      logger.error({ err }, "Download job failed");
    } finally {
      jobStatus.running = false;
      jobStatus.currentSong = null;
    }
  })();
}
