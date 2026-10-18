import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: ["src/lib/playlistExtraction.ts"],
  absWorkingDir: new URL("..", import.meta.url).pathname,
  bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{
    name: "no-external-services",
    setup(builder) {
      builder.onResolve({ filter: /^\.\/(logger|ytdlp)$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
        contents: args.path.endsWith("logger")
          ? "export const logger = {warn(){}};"
          : "export const runYtDlp = () => {throw new Error('Tests must supply a fixture runner')};",
      }));
    },
  }],
});
const { normalizePlaylistUrl, extractPlaylistMetadata } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);

test("YouTube Music / shared watch URLs retain the list ID and drop unrelated flags", () => {
  assert.equal(normalizePlaylistUrl("https://music.youtube.com/playlist?list=PLexample&si=tracking&drli=1"),
    "https://www.youtube.com/playlist?list=PLexample");
  assert.equal(normalizePlaylistUrl("https://www.youtube.com/watch?v=video&list=PLexample&index=5"),
    "https://www.youtube.com/playlist?list=PLexample");
});

test("transient playlist 403s retry with bounded backoff and then return the complete listing", async () => {
  let attempts = 0;
  const delays = [];
  const result = await extractPlaylistMetadata("https://music.youtube.com/playlist?list=PLexample", {
    run: async (args) => {
      assert.equal(args.at(-1), "https://www.youtube.com/playlist?list=PLexample");
      if (++attempts < 3) throw new Error("Unable to download API page: HTTP Error 403: Forbidden");
      return { stdout: "track\tTitle", stderr: "" };
    },
    wait: async (ms) => { delays.push(ms); },
  });
  assert.equal(result, "track\tTitle");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1500, 4000]);
});

test("persistent 403 stops after three attempts with a playlist-specific explanation", async () => {
  let attempts = 0;
  await assert.rejects(extractPlaylistMetadata("https://youtube.com/playlist?list=PLexample", {
    run: async () => { attempts++; throw new Error("HTTP Error 403: Forbidden"); },
    wait: async () => {},
  }), /refused to list.*after 3 attempts.*HTTP 403.*saved playlist was not changed/);
  assert.equal(attempts, 3);
});

test("a partial listing with an ignored continuation error is never accepted as complete", async () => {
  await assert.rejects(extractPlaylistMetadata("https://youtube.com/playlist?list=PLexample", {
    run: async () => ({ stdout: "partial\tTrack", stderr: "ERROR: Unable to download API page: HTTP Error 403" }),
    wait: async () => {},
  }), /saved playlist was not changed/);
});

test("unrelated errors are not repeatedly retried", async () => {
  let attempts = 0;
  await assert.rejects(extractPlaylistMetadata("https://youtube.com/playlist?list=PLexample", {
    run: async () => { attempts++; throw new Error("Private playlist"); },
    wait: async () => {},
  }), /Private playlist/);
  assert.equal(attempts, 1);
});
