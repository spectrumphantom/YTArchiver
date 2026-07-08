import { spawn } from "child_process";
import { promises as fs, createWriteStream } from "fs";
import path from "path";
import os from "os";
import { createHash } from "crypto";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { logger } from "./logger";

const YT_DLP_VERSION = "2026.07.04";
const YT_DLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp_linux`;
const YT_DLP_SHA256 =
  "6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae";

const BINARY_DIR = path.join(os.homedir(), "bin");
const BINARY_PATH = path.join(BINARY_DIR, "yt-dlp");

let ensured = false;
let ensuring: Promise<string> | null = null;

export async function ensureYtDlp(): Promise<string> {
  if (ensured) return BINARY_PATH;
  if (ensuring) return ensuring;

  ensuring = (async () => {
    try {
      await fs.access(BINARY_PATH, fs.constants.X_OK);
      ensured = true;
      return BINARY_PATH;
    } catch {
      // fall through to download
    }

    logger.info("Downloading yt-dlp standalone binary...");
    await fs.mkdir(BINARY_DIR, { recursive: true });
    const res = await fetch(YT_DLP_URL, { redirect: "follow" });
    if (!res.ok || !res.body) {
      throw new Error(`Failed to download yt-dlp: HTTP ${res.status}`);
    }
    const tmpPath = `${BINARY_PATH}.tmp`;
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
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, {
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
}
