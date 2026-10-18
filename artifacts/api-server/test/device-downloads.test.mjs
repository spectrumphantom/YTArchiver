import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

async function load(source) {
  const result = await build({
    entryPoints: [source], absWorkingDir: new URL("..", import.meta.url).pathname,
    bundle: true, platform: "node", format: "esm", write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { collectPlaylist, runDeviceQueue } = await load("../playlist-downloader/src/lib/sequentialDownloads.ts");
const { describeDownloadError } = await load("src/lib/downloadErrors.ts");

test("bulk snapshot fetches every playlist page and deduplicates video IDs", async () => {
  const pages = [];
  const items = await collectPlaylist(async (page) => {
    pages.push(page);
    return { songs: [{ id: `page${page}`, title: `Page ${page}` }, { id: "repeat", title: "Repeat" }], totalPages: 3 };
  });
  assert.deepEqual(pages, [1, 2, 3]);
  assert.deepEqual(items.map((item) => item.id), ["page1", "repeat", "page2", "page3"]);
});

function fixture(queue) {
  let now = 1000;
  const saves = [];
  const checkpoints = [];
  return {
    saves, checkpoints,
    io: {
      getSong: async (id) => ({ id, status: id === "bad" ? "error" : "done" }),
      preparing: async () => true,
      save: async (id) => { saves.push({ id, time: now }); now += 100; },
      persist: (next) => { checkpoints.push(structuredClone(next)); },
      wait: async (ms) => { now += ms; },
      now: () => now,
      checkCancelled() {},
    },
  };
}
const queueFor = (ids) => ({
  id: "device", items: ids.map((id) => ({ id, title: id })),
  cursor: 0, failed: 0, active: true, nextSaveAt: 0,
});

test("device saves are individual and wait at least three seconds after each completed save", async () => {
  const queue = queueFor(["one", "two", "three"]);
  const { io, saves, checkpoints } = fixture(queue);
  await runDeviceQueue(queue, io);
  assert.deepEqual(saves.map((save) => save.id), ["one", "two", "three"]);
  assert.ok(saves[1].time - saves[0].time >= 3100);
  assert.ok(saves[2].time - saves[1].time >= 3100);
  assert.equal(checkpoints.at(-1).cursor, 3);
  assert.equal(checkpoints.at(-1).active, false);
});

test("device queue restored from storage skips saved tracks, keeps delay, and continues past errors", async () => {
  const queue = JSON.parse(JSON.stringify({ ...queueFor(["saved", "bad", "next", "last"]), cursor: 1, nextSaveAt: 4000 }));
  const { io, saves, checkpoints } = fixture(queue);
  await runDeviceQueue(queue, io);
  assert.deepEqual(saves.map((save) => save.id), ["next", "last"]);
  assert.equal(saves[0].time, 4000);
  assert.equal(checkpoints.at(-1).failed, 1);
  assert.equal(checkpoints.at(-1).cursor, 4);
});

test("save failure retains the current cursor so resume retries the unsaved file", async () => {
  const queue = queueFor(["one", "two"]);
  const { io, checkpoints } = fixture(queue);
  io.save = async () => { throw new Error("Network interrupted"); };
  await assert.rejects(runDeviceQueue(queue, io), /Network interrupted/);
  assert.equal(queue.cursor, 0);
  assert.deepEqual(checkpoints, []);
});

test("a pending track waits for preparation; paused preparation preserves progress", async () => {
  const queue = queueFor(["one"]);
  const { io, saves } = fixture(queue);
  let queries = 0;
  io.getSong = async () => ({ status: queries++ === 0 ? "pending" : "done" });
  await runDeviceQueue(queue, io);
  assert.equal(saves.length, 1);
  const paused = queueFor(["one"]);
  io.getSong = async () => ({ status: "pending" });
  io.preparing = async () => false;
  await assert.rejects(runDeviceQueue(paused, io), /paused or stopped/);
  assert.equal(paused.cursor, 0);
});

test("YouTube failures explain bot verification, privacy, region, rate limits, and non-YouTube errors", () => {
  for (const [message, pattern] of [
    ["ERROR: Sign in to confirm you're not a bot", /bot verification/],
    ["ERROR: Private video", /private/],
    ["ERROR: Please confirm your age", /age verification/],
    ["ERROR: Not available in your country", /region/],
    ["ERROR: HTTP Error 429: Too many requests", /rate-limited/],
    ["ERROR: HTTP Error 403: Forbidden", /refused access/],
    ["yt-dlp timed out", /network connection/],
    ["No audio file produced", /processing or storage/],
  ]) {
    const result = describeDownloadError(new Error(message));
    assert.match(result.errorReason, pattern);
    assert.ok(result.errorDetails);
  }
});
