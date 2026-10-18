import type { Song, SongPage } from "@workspace/api-client-react";

export interface DeviceQueue {
  id: string;
  items: { id: string; title: string }[];
  cursor: number;
  failed: number;
  active: boolean;
  nextSaveAt: number;
}

/** The server said the song's audio is not available yet (HTTP 404). */
export class SongNotReadyError extends Error {
  constructor(message = "Song not downloaded yet") {
    super(message);
    this.name = "SongNotReadyError";
  }
}

// Consecutive attempts to prepare/save one song before it is counted as failed
// and the queue moves on, so a single bad song can never block the rest.
const MAX_RECOVERY_ATTEMPTS = 5;

export async function collectPlaylist(
  getPage: (page: number) => Promise<SongPage>,
): Promise<DeviceQueue["items"]> {
  const items: DeviceQueue["items"] = [];
  const seen = new Set<string>();
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    const result = await getPage(page);
    totalPages = result.totalPages;
    for (const song of result.songs) {
      if (!seen.has(song.id)) {
        seen.add(song.id);
        items.push({ id: song.id, title: song.title });
      }
    }
  }
  return items;
}

export async function runDeviceQueue(queue: DeviceQueue, io: {
  getSong: (id: string) => Promise<Song>;
  /** Starts the server job if it is not running. Resolves true when it had to start one. */
  ensurePreparing: () => Promise<boolean>;
  save: (id: string, title: string) => Promise<void>;
  persist: (queue: DeviceQueue) => void;
  wait: (ms: number) => Promise<void>;
  now: () => number;
  checkCancelled: () => void;
}): Promise<void> {
  let recoveries = 0;
  const advance = (failed: boolean) => {
    if (failed) queue.failed++;
    queue.cursor++;
    queue.active = queue.cursor < queue.items.length;
    recoveries = 0;
    io.persist({ ...queue });
  };

  while (queue.cursor < queue.items.length) {
    io.checkCancelled();
    const item = queue.items[queue.cursor];
    const song = await io.getSong(item.id);
    io.checkCancelled();

    if (song.status === "pending" || song.status === "downloading") {
      // Automatically resume server-side preparation if it stopped early.
      if (await io.ensurePreparing()) recoveries++;
      if (recoveries > MAX_RECOVERY_ATTEMPTS) {
        advance(true);
        continue;
      }
      await io.wait(2000);
      continue;
    }

    if (song.status === "done") {
      // Timers can fire early; recheck the deadline before dispatching the file.
      while (queue.nextSaveAt > io.now()) {
        await io.wait(queue.nextSaveAt - io.now());
      }
      io.checkCancelled();
      try {
        await io.save(item.id, item.title);
      } catch (err) {
        if (!(err instanceof SongNotReadyError)) throw err;
        // HTTP 404: the server does not have the audio. Resume the server job
        // (which re-verifies storage) and retry this same song.
        recoveries++;
        if (recoveries > MAX_RECOVERY_ATTEMPTS) {
          advance(true);
          continue;
        }
        await io.ensurePreparing();
        await io.wait(2000);
        continue;
      }
      // Download events are delivered asynchronously by the browser. A small
      // margin keeps their observed spacing at least three seconds as well.
      queue.nextSaveAt = io.now() + 3050;
      advance(false);
      continue;
    }

    advance(true);
  }
}
