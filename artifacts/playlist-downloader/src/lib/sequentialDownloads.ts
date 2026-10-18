import type { Song, SongPage } from "@workspace/api-client-react";

export interface DeviceQueue {
  id: string;
  items: { id: string; title: string }[];
  cursor: number;
  failed: number;
  active: boolean;
  nextSaveAt: number;
}

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
  preparing: () => Promise<boolean>;
  save: (id: string, title: string) => Promise<void>;
  persist: (queue: DeviceQueue) => void;
  wait: (ms: number) => Promise<void>;
  now: () => number;
  checkCancelled: () => void;
}): Promise<void> {
  while (queue.cursor < queue.items.length) {
    io.checkCancelled();
    const item = queue.items[queue.cursor];
    const song = await io.getSong(item.id);
    io.checkCancelled();
    if (song.status === "pending" || song.status === "downloading") {
      if (!await io.preparing()) throw new Error("Audio preparation is paused or stopped. Choose Resume Downloads to continue.");
      await io.wait(2000);
      continue;
    }
    if (song.status === "done") {
      // Timers can fire early; recheck the deadline before dispatching the file.
      while (queue.nextSaveAt > io.now()) {
        await io.wait(queue.nextSaveAt - io.now());
      }
      io.checkCancelled();
      await io.save(item.id, item.title);
      // Download events are delivered asynchronously by the browser. A small
      // margin keeps their observed spacing at least three seconds as well.
      queue.nextSaveAt = io.now() + 3050;
    } else {
      queue.failed++;
    }
    queue.cursor++;
    queue.active = queue.cursor < queue.items.length;
    io.persist({ ...queue });
  }
}
