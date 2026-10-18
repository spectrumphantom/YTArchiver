import { objectStorageClient } from "./objectStorage";
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
  playlistSongIds?: string[];
  playlistUrl?: string;
  lastUpdated: string;
}

export function getPlaylistSongs(manifest: Manifest): Song[] {
  return manifest.playlistSongIds
    ? manifest.playlistSongIds.map((id) => manifest.songs[id]).filter((song): song is Song => Boolean(song))
    : Object.values(manifest.songs);
}

const MANIFEST_PATH = "playlist-downloader/manifest.json";

function getBucketId(): string {
  const id = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  if (!id) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");
  return id;
}

function emptyManifest(): Manifest {
  return { songs: {}, playlistTitle: "", lastUpdated: new Date().toISOString() };
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === 404
  );
}

function isPreconditionFailed(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === 412
  );
}

async function readManifestWithGeneration(): Promise<{
  manifest: Manifest;
  generation: number;
}> {
  const bucket = objectStorageClient.bucket(getBucketId());
  const file = bucket.file(MANIFEST_PATH);
  try {
    const [metadata] = await file.getMetadata();
    const generation = Number(metadata.generation);
    const [content] = await bucket
      .file(MANIFEST_PATH, { generation })
      .download();
    return {
      manifest: JSON.parse(content.toString("utf-8")) as Manifest,
      generation,
    };
  } catch (err) {
    if (isNotFound(err)) {
      return { manifest: emptyManifest(), generation: 0 };
    }
    throw err;
  }
}

export async function readManifest(): Promise<Manifest> {
  try {
    const { manifest } = await readManifestWithGeneration();
    return manifest;
  } catch (err) {
    logger.error({ err }, "Failed to read manifest");
    throw err;
  }
}

const MAX_CAS_ATTEMPTS = 5;

export async function mutateManifest<T>(
  mutator: (manifest: Manifest) => T | Promise<T>
): Promise<{ manifest: Manifest; result: T }> {
  const bucket = objectStorageClient.bucket(getBucketId());
  const file = bucket.file(MANIFEST_PATH);

  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
    const { manifest, generation } = await readManifestWithGeneration();
    const result = await mutator(manifest);
    manifest.lastUpdated = new Date().toISOString();
    try {
      await file.save(JSON.stringify(manifest, null, 2), {
        contentType: "application/json",
        preconditionOpts: { ifGenerationMatch: generation },
        resumable: false,
      });
      return { manifest, result };
    } catch (err) {
      if (isPreconditionFailed(err) && attempt < MAX_CAS_ATTEMPTS) {
        logger.warn(
          { attempt },
          "Manifest write conflict, retrying with fresh copy"
        );
        await new Promise((r) => setTimeout(r, 100 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Failed to update manifest after concurrent write conflicts");
}

export async function updateSong(id: string, updates: Partial<Song>): Promise<void> {
  await mutateManifest((manifest) => {
    if (!manifest.songs[id]) return;
    manifest.songs[id] = { ...manifest.songs[id], ...updates };
  });
}
