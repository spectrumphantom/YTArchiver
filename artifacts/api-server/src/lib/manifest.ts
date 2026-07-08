import { Storage } from "@google-cloud/storage";
import { logger } from "./logger";

export interface Song {
  id: string;
  title: string;
  channel: string;
  duration: number;
  thumbnailUrl: string | null;
  status: "pending" | "downloading" | "done" | "error";
  bucketPath: string | null;
  addedAt: string;
  downloadedAt: string | null;
}

export interface Manifest {
  songs: Record<string, Song>;
  playlistTitle: string;
  lastUpdated: string;
}

const MANIFEST_PATH = "playlist-downloader/manifest.json";

function getStorage(): Storage {
  return new Storage();
}

function getBucketId(): string {
  const id = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  if (!id) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");
  return id;
}

export async function readManifest(): Promise<Manifest> {
  try {
    const storage = getStorage();
    const bucket = storage.bucket(getBucketId());
    const file = bucket.file(MANIFEST_PATH);
    const [exists] = await file.exists();
    if (!exists) {
      return { songs: {}, playlistTitle: "", lastUpdated: new Date().toISOString() };
    }
    const [content] = await file.download();
    return JSON.parse(content.toString("utf-8")) as Manifest;
  } catch (err) {
    logger.error({ err }, "Failed to read manifest, returning empty");
    return { songs: {}, playlistTitle: "", lastUpdated: new Date().toISOString() };
  }
}

export async function writeManifest(manifest: Manifest): Promise<void> {
  const storage = getStorage();
  const bucket = storage.bucket(getBucketId());
  const file = bucket.file(MANIFEST_PATH);
  await file.save(JSON.stringify(manifest, null, 2), {
    contentType: "application/json",
  });
}

export async function updateSong(id: string, updates: Partial<Song>): Promise<void> {
  const manifest = await readManifest();
  if (!manifest.songs[id]) return;
  manifest.songs[id] = { ...manifest.songs[id], ...updates };
  manifest.lastUpdated = new Date().toISOString();
  await writeManifest(manifest);
}
