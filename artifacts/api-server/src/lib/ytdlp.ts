import { spawn } from "child_process";
import { promises as fs, createWriteStream } from "fs";
import path from "path";
import os from "os";
import { createHash } from "crypto";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { logger } from "./logger";

const YT_DLP_VERSION = "2026.08.19";
const YT_DLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp_linux`;
const YT_DLP_SHA256 =
  "58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a";

const BINARY_DIR = path.join(os.homedir(), "bin");
// A new pin must not silently reuse an executable from a previous release.
const BINARY_PATH = path.join(BINARY_DIR, `yt-dlp-${YT_DLP_VERSION}`);

let ensured = false;
let ensuring: Promise<string> | null = null;

export async function ensureYtDlp(): Promise<string> {
  if (ensured) return BINARY_PATH;
  if (ensuring) return ensuring;

  ensuring = (async () => {
    try {
      await fs.access(BINARY_PATH, fs.constants.X_OK);
      const installedHash = createHash("sha256").update(await fs.readFile(BINARY_PATH)).digest("hex");
      if (installedHash === YT_DLP_SHA256) {
        ensured = true;
        return BINARY_PATH;
      }
      logger.warn("Installed yt-dlp checksum differs from the pinned release; replacing it");
    } catch {
      // fall through to download
    }

    logger.info({ version: YT_DLP_VERSION }, "Downloading yt-dlp standalone binary...");
    await fs.mkdir(BINARY_DIR, { recursive: true });
    const res = await fetch(YT_DLP_URL, { redirect: "follow" });
    if (!res.ok || !res.body) {
      throw new Error(`Failed to download yt-dlp: HTTP ${res.status}`);
    }
    const tmpPath = `${BINARY_PATH}.${process.pid}.tmp`;
    await pipeline(
      Readable.fromWeb(res.body as import("stream/web").ReadableStream),
      createWriteStream(tmpPath)
    );

    const fileBuffer = await fs.readFile(tmpPath);
    const actualHash = createHash("sha256").update(fileBuffer).digest("hex");
    if (actualHash !== YT_DLP_SHA256) {
      await fs.rm(tmpPath, { force: true });
      throw new Error(
        `yt-dlp binary checksum mismatch: expected ${YT_DLP_SHA256}, got ${actualHash}`
      );
    }

    await fs.chmod(tmpPath, 0o755);
    await fs.rename(tmpPath, BINARY_PATH);
    logger.info("yt-dlp binary downloaded");
    ensured = true;
    return BINARY_PATH;
  })();

  try {
    return await ensuring;
  } finally {
    ensuring = null;
  }
}

export interface YtDlpResult {
  stdout: string;
  stderr: string;
}

export async function runYtDlp(
  args: string[],
  timeoutMs = 30 * 60 * 1000,
  signal?: AbortSignal
): Promise<YtDlpResult> {
  const binary = await ensureYtDlp();
  let cookieDir: string | undefined;
  try {
    const cookieJar = process.env.YOUTUBE_COOKIES?.trim();
    let ytDlpArgs = args;
    if (cookieJar) {
      const cookieRows = cookieJar
        .split(/\r?\n/)
        .filter((line) => line.trim() && !line.startsWith("#") && !line.startsWith("#HttpOnly_"));
      const httpOnlyRows = cookieJar
        .split(/\r?\n/)
        .filter((line) => line.startsWith("#HttpOnly_"));
      const dataRows = [...cookieRows, ...httpOnlyRows];
      if (dataRows.length === 0 || dataRows.some((line) => line.split("\t").length !== 7)) {
        throw new Error("YOUTUBE_COOKIES must contain a Netscape-format cookie jar.");
      }

      cookieDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-dlp-cookies-"));
      const cookiePath = path.join(cookieDir, "cookies.txt");
      await fs.writeFile(cookiePath, cookieJar, { mode: 0o600 });
      ytDlpArgs = ["--cookies", cookiePath, ...args];
    }

    return await new Promise((resolve, reject) => {
      const proc = spawn(binary, ytDlpArgs, {
        env: { ...process.env, PATH: process.env.PATH ?? "" },
        signal,
      });

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("yt-dlp timed out"));
      }, timeoutMs);

      proc.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      proc.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(
            new Error(`yt-dlp exited with code ${code}: ${stderr.slice(-800)}`)
          );
        }
      });
    });
  } finally {
    if (cookieDir) await fs.rm(cookieDir, { recursive: true, force: true });
  }
}
