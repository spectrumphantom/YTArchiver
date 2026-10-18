export function describeDownloadError(error: unknown): { errorReason: string; errorDetails: string } {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const detail = (lines.find((line) => /ERROR:/i.test(line)) || lines.find((line) => line.trim()) || "Unknown download error")
    .replace(/^.*?ERROR:\s*/i, "").trim().slice(0, 800);
  let reason = "The download failed. See the diagnostic below and retry the song.";
  if (/not a bot|confirm.*bot|sign in.*confirm/i.test(message)) {
    reason = "YouTube blocked this server with a sign-in / bot verification challenge.";
  } else if (/private video/i.test(message)) {
    reason = "This video is private. YouTube does not allow public access.";
  } else if (/age.?restrict|confirm your age/i.test(message)) {
    reason = "This video requires age verification, which this downloader cannot provide.";
  } else if (/country|region|geo.?restrict/i.test(message)) {
    reason = "YouTube does not make this video available in the server's region.";
  } else if (/copyright|removed|deleted|unavailable|members.only|premium|sign in/i.test(message)) {
    reason = "YouTube restricted or removed this video. See its exact message below.";
  } else if (/429|too many requests|rate.limit/i.test(message)) {
    reason = "YouTube temporarily rate-limited requests. Wait before retrying.";
  } else if (/403|forbidden/i.test(message)) {
    reason = "YouTube refused access to the audio stream (HTTP 403).";
  } else if (/timed out|timeout|network|ENOTFOUND|ECONN/i.test(message)) {
    reason = "A network connection failed or timed out. This is not necessarily a YouTube rejection.";
  } else if (/ffmpeg|audio file|storage|bucket/i.test(message)) {
    reason = "Audio processing or storage failed, rather than a YouTube rejection.";
  }
  return { errorReason: reason, errorDetails: detail };
}
