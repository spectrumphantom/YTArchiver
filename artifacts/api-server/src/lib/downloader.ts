import YTDlpWrap from "yt-dlp-wrap";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { Storage } from "@google-cloud/storage";
import { readManifest, writeManifest, updateSong, type Song } from "./manifest";
import { logger } from "./logger";

const AUDIO_PREFIX = "playlist-downloader/audio";
const YT_DLP_BINARY = "/home/runner/bin/yt-dlp";

let ytDlp: YTDlpWrap | null = null;

async function getYtDlp(): Promise<YTDlpWrap> {
  if (ytDlp) return ytDlp;
  try {
    await fs.access(YT_DLP_BINARY);
    ytDlp = new YTDlpWrap(YT_DLP_BINARY);
    logger.info("Using cached yt-dlp binary");
  } catch {
    logger.info("Downloading yt-dlp binary...");
    await YTDlpWrap.downloadFromGithub(YT_DLP_BINARY);
    ytDlp = new YTDlpWrap(YT_DLP_BINARY);
    logger.info("yt-dlp binary downloaded");
  }
  return ytDlp;
}

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
  const yt = await getYtDlp();

  const output: string = await yt.execPromise([
    "--flat-playlist",
    "--print", "%(id)s\t%(title)s\t%(uploader)s\t%(duration)s\t%(thumbnail)s",
    "--no-warnings",
    "--ignore-errors",
    url,
  ]);

  let playlistTitle = "YouTube Playlist";
  try {
    const titleOutput: string = await yt.execPromise([
      "--flat-playlist",
      "--print", "%(playlist_title)s",
      "--playlist-end", "1",
      "--no-warnings",
      url,
    ]);
    playlistTitle = titleOutput.trim().split("\n")[0] || "YouTube Playlist";
  } catch {
    playlistTitle = "YouTube Playlist";
  }

  const manifest = await readManifest();
  let newAdded = 0;
  let alreadyExists = 0;

  const lines = output.trim().split("\n").filter((l) => l.includes("\t"));
  for (const line of lines) {
    const parts = line.split("\t");
    const [id, title, channel, durationStr, thumbnailUrl] = parts;
    if (!id || !title) continue;

    if (manifest.songs[id]) {
      alreadyExists++;
      continue;
    }

    const song: Song = {
      id,
      title: title || "Unknown",
      channel: channel || "Unknown",
      duration: parseInt(durationStr || "0", 10) || 0,
      thumbnailUrl: thumbnailUrl && thumbnailUrl !== "NA" && thumbnailUrl !== "None" ? thumbnailUrl : null,
      status: "pending",
      bucketPath: null,
      addedAt: new Date().toISOString(),
      downloadedAt: null,
    };

    manifest.songs[id] = song;
    newAdded++;
  }

  if (playlistTitle) manifest.playlistTitle = playlistTitle;
  manifest.lastUpdated = new Date().toISOString();
  await writeManifest(manifest);

  return {
    totalFound: lines.length,
    newAdded,
    alreadyExists,
    playlistTitle: manifest.playlistTitle || playlistTitle,
    songs: Object.values(manifest.songs),
  };
}

async function downloadSingleSong(song: Song): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-"));
  try {
    await updateSong(song.id, { status: "downloading" });
    const yt = await getYtDlp();

    await yt.execPromise([
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      "--output", path.join(tmpDir, "%(id)s.%(ext)s"),
      "--no-playlist",
      "--no-warnings",
      "--ignore-errors",
      `https://www.youtube.com/watch?v=${song.id}`,
    ]);

    const files = await fs.readdir(tmpDir);
    const audioFile = files.find(
      (f) => f.endsWith(".mp3") || f.endsWith(".m4a") || f.endsWith(".opus") || f.endsWith(".webm")
    );
    if (!audioFile) throw new Error("No audio file produced");

    const localPath = path.join(tmpDir, audioFile);
    const ext = path.extname(audioFile);
    const bucketPath = `${AUDIO_PREFIX}/${song.id}${ext}`;

    const storage = new Storage();
    const bucket = storage.bucket(getBucketId());
    await bucket.upload(localPath, {
      destination: bucketPath,
      metadata: { contentType: "audio/mpeg" },
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
  jobStatus = { running: true, currentSong: null, pending: 0, completed: 0, failed: 0 };

  (async () => {
    try {
      const manifest = await readManifest();
      const pending = Object.values(manifest.songs).filter(
        (s) => s.status === "pending" || s.status === "downloading"
      );

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
