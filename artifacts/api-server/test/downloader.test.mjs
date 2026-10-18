import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import express from "express";

// Exercise the real scraper/manifest/queue without touching the user's bucket
// or downloading copyrighted test media from YouTube.
const state = {
  manifest: { songs: {}, playlistTitle: "", lastUpdated: "" },
  generation: 1,
  output: "",
  calls: [],
  active: 0,
  maxActive: 0,
  failId: null,
};
globalThis.__playlistTest = state;
state.storage = {
  bucket: () => ({
    file: (name) => ({
      getMetadata: async () => [{ generation: String(state.generation) }],
      download: async () => [Buffer.from(JSON.stringify(state.manifest))],
      save: async (content, options) => {
        assert.equal(options.preconditionOpts.ifGenerationMatch, state.generation);
        state.manifest = JSON.parse(content);
        state.generation++;
      },
      exists: async () => [true],
      createReadStream: () => Readable.from([Buffer.from(`audio:${name}`)]),
    }),
    upload: async () => {},
  }),
};
state.runYtDlp = async (args) => {
  if (args.includes("--flat-playlist")) return { stdout: state.output };
  const id = new URL(args.at(-1)).searchParams.get("v");
  state.calls.push(id);
  state.active++;
  state.maxActive = Math.max(state.maxActive, state.active);
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (id === state.failId) throw new Error("Fixture video unavailable");
    const template = args[args.indexOf("--output") + 1];
    await writeFile(path.join(path.dirname(template), `${id}.mp3`), "fixture audio");
    return { stdout: "" };
  } finally {
    state.active--;
  }
};
const result = await build({
  entryPoints: ["src/lib/downloader.ts"],
  absWorkingDir: new URL("..", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [{
    name: "fixture-services",
    setup(builder) {
      builder.onResolve({ filter: /^\.\/(objectStorage|ytdlp|logger)$/ }, (args) => ({
        path: args.path,
        namespace: "fixture",
      }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
        contents: args.path.endsWith("objectStorage")
          ? "export const objectStorageClient = globalThis.__playlistTest.storage;"
          : args.path.endsWith("ytdlp")
            ? "export const runYtDlp = (...args) => globalThis.__playlistTest.runYtDlp(...args);"
            : "export const logger = { info() {}, error() {}, warn() {} };",
      }));
    },
  }],
});
process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID = "fixture-only";
const downloader = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const song = (id, status = "pending") => ({
  id, title: id, channel: "Fixture", duration: 60, thumbnailUrl: null,
  status, bucketPath: status === "done" ? `${id}.mp3` : null,
  addedAt: "2026-01-01T00:00:00Z", downloadedAt: null,
});
async function finishJob() {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (!downloader.getJobStatus().running) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Download queue did not finish");
}

test("latest scrape replaces displayed membership, refreshes metadata, and preserves saved audio", async () => {
  state.manifest = { songs: { old: song("old"), saved: song("saved", "done") }, playlistTitle: "Old" };
  state.output = "new\tNew Track\tChannel\t123\tNA\tLatest Playlist\nsaved\tUpdated Title\tChannel\t99\tNA\tLatest Playlist\n";
  const scraped = await downloader.scrapePlaylist("https://www.youtube.com/playlist?list=fixture");
  assert.deepEqual(scraped.songs.map((item) => item.id), ["new", "saved"]);
  assert.equal(scraped.playlistTitle, "Latest Playlist");
  assert.equal(scraped.newAdded, 1);
  assert.equal(scraped.alreadyExists, 1);
  assert.equal(state.manifest.songs.saved.bucketPath, "saved.mp3");
  assert.equal(state.manifest.songs.saved.status, "done");
  assert.equal(state.manifest.songs.saved.title, "Updated Title");
  assert.ok(state.manifest.songs.old, "Previous songs must not be deleted");
});

test("Download All processes every current track sequentially, retries errors, and skips completed/old tracks", async () => {
  state.manifest = {
    songs: { a: song("a"), b: song("b", "error"), c: song("c", "done"), old: song("old") },
    playlistSongIds: ["a", "b", "c"],
    playlistTitle: "Queue",
  };
  state.calls = [];
  state.maxActive = 0;
  await downloader.startDownloadJob();
  await finishJob();
  assert.deepEqual(state.calls, ["a", "b"]);
  assert.equal(state.maxActive, 1);
  assert.equal(downloader.getJobStatus().completed, 2);
  assert.equal(state.manifest.songs.old.status, "pending");
});

test("one-song download only processes its chosen track", async () => {
  state.calls = [];
  await downloader.startDownloadJob(["old"]);
  await finishJob();
  assert.deepEqual(state.calls, ["old"]);
  assert.equal(state.manifest.songs.old.status, "done");
});

test("a failed track does not stop the rest of the queue", async () => {
  state.manifest.songs.a.status = "pending";
  state.manifest.songs.b.status = "pending";
  state.failId = "a";
  state.calls = [];
  await downloader.startDownloadJob(["a", "b"]);
  await finishJob();
  assert.deepEqual(state.calls, ["a", "b"]);
  assert.equal(state.manifest.songs.a.status, "error");
  assert.equal(state.manifest.songs.b.status, "done");
  assert.equal(downloader.getJobStatus().failed, 1);
  state.failId = null;
});

test("an empty/private playlist fails without replacing the previous playlist", async () => {
  const previousIds = [...state.manifest.playlistSongIds];
  state.output = "hidden\t[Private video]\tNA\tNA\tNA\tPrivate\n";
  await assert.rejects(downloader.scrapePlaylist("https://youtube.com/playlist?list=private"));
  assert.deepEqual(state.manifest.playlistSongIds, previousIds);
});

test("Save ZIP includes completed current tracks only and individual downloads support Unicode titles", async () => {
  const bundled = await build({
    entryPoints: ["src/routes/songs.ts"],
    absWorkingDir: new URL("..", import.meta.url).pathname,
    bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{
      name: "fixture-storage",
      setup(builder) {
        builder.onResolve({ filter: /^(express|archiver)$/ }, (args) => ({
          path: import.meta.resolve(args.path), external: true,
        }));
        builder.onResolve({ filter: /\/(objectStorage|logger)$/ }, (args) => ({
          path: args.path, namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents: args.path.endsWith("objectStorage")
            ? "export const objectStorageClient = globalThis.__playlistTest.storage;"
            : "export const logger = { info() {}, error() {}, warn() {} };",
        }));
      },
    }],
  });
  const { default: songsRouter } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
  state.manifest.songs.b.title = "日本語 song";
  const app = express();
  app.use((req, _res, next) => {
    req.log = { error() {}, warn() {} };
    next();
  });
  app.use(songsRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const listed = await (await fetch(`${base}/songs`)).json();
    assert.deepEqual(listed.songs.map((item) => item.id), ["a", "b", "c"]);
    const stats = await (await fetch(`${base}/songs/stats`)).json();
    assert.equal(stats.total, 3);
    const response = await fetch(`${base}/songs/download-all`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/zip");
    const zip = Buffer.from(await response.arrayBuffer());
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    assert.ok(zip.includes(Buffer.from("audio:playlist-downloader/audio/b_[b].mp3")));
    assert.ok(!zip.includes(Buffer.from("old_[old]")), "Archived songs outside the current playlist must not be exported");
    const individual = await fetch(`${base}/songs/b/download`);
    assert.equal(individual.status, 200);
    assert.ok(individual.headers.get("content-disposition").includes(encodeURIComponent("日本語")));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
