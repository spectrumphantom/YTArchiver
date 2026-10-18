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
const { collectPlaylist, runDeviceQueue, SongNotReadyError } = await load("../playlist-downloader/src/lib/sequentialDownloads.ts");
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
      ensurePreparing: async () => false,
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

test("a pending track waits for preparation and resumes the server job if it stopped", async () => {
  const queue = queueFor(["one"]);
  const { io, saves } = fixture(queue);
  let queries = 0;
  let resumed = 0;
  io.getSong = async () => ({ status: queries++ < 2 ? "pending" : "done" });
  io.ensurePreparing = async () => { resumed++; return true; };
  await runDeviceQueue(queue, io);
  assert.equal(saves.length, 1);
  assert.equal(resumed, 2);
});

test("a song that never becomes ready is counted failed and the queue moves on", async () => {
  const queue = queueFor(["stuck", "next"]);
  const { io, saves } = fixture(queue);
  io.getSong = async (id) => ({ status: id === "stuck" ? "pending" : "done" });
  io.ensurePreparing = async () => true;
  await runDeviceQueue(queue, io);
  assert.deepEqual(saves.map((save) => save.id), ["next"]);
  assert.equal(queue.failed, 1);
  assert.equal(queue.cursor, 2);
});

test("HTTP 404 (song not downloaded yet) automatically resumes the job and retries the same song", async () => {
  const queue = queueFor(["one", "two"]);
  const { io, saves, checkpoints } = fixture(queue);
  let attempts = 0;
  let resumed = 0;
  const save = io.save;
  io.save = async (id, title) => {
    if (id === "one" && attempts++ < 2) throw new SongNotReadyError();
    return save(id, title);
  };
  io.ensurePreparing = async () => { resumed++; return true; };
  await runDeviceQueue(queue, io);
  assert.deepEqual(saves.map((entry) => entry.id), ["one", "two"]);
  assert.equal(resumed, 2);
  assert.equal(checkpoints.at(-1).failed, 0);
  assert.equal(checkpoints.at(-1).cursor, 2);
});

test("a song that keeps returning 404 is skipped so later pages still download", async () => {
  const queue = queueFor(["bad", "good"]);
  const { io, saves } = fixture(queue);
  const save = io.save;
  io.save = async (id, title) => {
    if (id === "bad") throw new SongNotReadyError();
    return save(id, title);
  };
  await runDeviceQueue(queue, io);
  assert.deepEqual(saves.map((entry) => entry.id), ["good"]);
  assert.equal(queue.failed, 1);
});

test("the queue continues across every page of a large playlist", async () => {
  const ids = Array.from({ length: 120 }, (_, i) => `song${i}`);
  const items = await collectPlaylist(async (page) => ({
    songs: ids.slice((page - 1) * 50, page * 50).map((id) => ({ id, title: id })),
    totalPages: 3,
  }));
  assert.equal(items.length, 120);
  const queue = { ...queueFor([]), items };
  const { io, saves } = fixture(queue);
  await runDeviceQueue(queue, io);
  assert.equal(saves.length, 120);
  assert.equal(queue.cursor, 120);
  assert.equal(queue.active, false);
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
