import { useEffect, useState } from "react";
import { downloadSong, getSong, getDownloadStatus } from "@workspace/api-client-react";
import { runDeviceQueue, type DeviceQueue } from "@/lib/sequentialDownloads";

export async function saveAudioFile(id: string, title: string, signal?: AbortSignal) {
  const blob = await downloadSong(id, { signal });
  signal?.throwIfAborted();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `${title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || id}.mp3`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

function readSavedQueue(key: string): DeviceQueue | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const value = JSON.parse(raw) as DeviceQueue;
  if (!value || typeof value.id !== "string" || !Array.isArray(value.items)
    || !value.items.every((item) => item && typeof item.id === "string" && typeof item.title === "string")
    || !Number.isInteger(value.cursor) || value.cursor < 0 || value.cursor > value.items.length
    || !Number.isInteger(value.failed) || typeof value.active !== "boolean"
    || !Number.isFinite(value.nextSaveAt)) throw new Error("Saved download progress is invalid. Start Download All again to replace it.");
  return value;
}

export function useDeviceDownloads(userId: string | undefined) {
  const [queue, setQueue] = useState<DeviceQueue | null>(null);
  const [error, setError] = useState("");
  const key = userId ? `playlist-device-downloads:${userId}` : null;
  // Do not start an old user's queue while account state is changing.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const persist = (next: DeviceQueue) => {
    if (!key) throw new Error("Sign in before downloading.");
    localStorage.setItem(key, JSON.stringify(next));
    setQueue(next);
  };

  useEffect(() => {
    setError("");
    setQueue(null);
    if (key) {
      try { setQueue(readSavedQueue(key)); }
      catch (err) { setError(err instanceof Error ? err.message : "Unable to read saved progress."); }
    }
    setLoadedKey(key);
  }, [key]);

  useEffect(() => {
    if (!queue?.active || !key || loadedKey !== key) return;
    const controller = new AbortController();
    const { signal } = controller;
    const current = structuredClone(queue);
    const wait = (ms: number) => new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const cancelled = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = window.setTimeout(() => { signal.removeEventListener("abort", cancelled); resolve(); }, ms);
      signal.addEventListener("abort", cancelled, { once: true });
    });
    // Retry connection loss during a server restart without discarding progress.
    const reconnect = async <T,>(operation: () => Promise<T>): Promise<T> => {
      for (;;) {
        signal.throwIfAborted();
        try {
          const result = await operation();
          setError("");
          return result;
        } catch (err) {
          signal.throwIfAborted();
          const status = (err as { status?: number }).status;
          if (status && status < 500) throw err;
          setError("Connection interrupted. Waiting to reconnect; progress is saved.");
          await wait(3000);
        }
      }
    };
    void runDeviceQueue(current, {
      getSong: (id) => reconnect(() => getSong(id, { signal })),
      preparing: () => reconnect(async () => (await getDownloadStatus({ signal })).running),
      save: (id, title) => saveAudioFile(id, title, signal),
      persist,
      wait,
      now: Date.now,
      checkCancelled: () => signal.throwIfAborted(),
    }).catch((err) => {
      if (signal.aborted) return;
      try { persist({ ...current, active: false }); } catch { setQueue({ ...current, active: false }); }
      setError(err instanceof Error ? err.message : "Unable to save a song. Resume to retry.");
    });
    return () => controller.abort();
    // Progress checkpoints must not restart an in-flight file request.
  }, [key, loadedKey, queue?.id, queue?.active]);

  return {
    queue: loadedKey === key ? queue : null,
    error,
    begin(items: DeviceQueue["items"], active = true) {
      setError("");
      const next = { id: crypto.randomUUID(), items, cursor: 0, failed: 0, active: active && items.length > 0, nextSaveAt: 0 };
      persist(next);
      return next;
    },
    activate(next: DeviceQueue) {
      setError("");
      persist({ ...next, active: next.cursor < next.items.length });
    },
    resume() {
      if (queue) { setError(""); persist({ ...queue, active: true }); }
    },
    pause() {
      if (queue) persist({ ...queue, active: false });
    },
    clear() {
      if (key) localStorage.removeItem(key);
      setQueue(null);
      setError("");
    },
  };
}
