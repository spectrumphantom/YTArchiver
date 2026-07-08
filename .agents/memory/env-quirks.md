---
name: Environment quirks (yt-dlp, object storage)
description: No Python in env; object storage requires Replit sidecar auth, not default GCS credentials
---
- No `python3`/`pip` in this Replit env and nix installs are unreliable. For yt-dlp, use the standalone `yt-dlp_linux` binary (pinned version + sha256 verified, auto-downloaded to `~/bin/yt-dlp`). ffmpeg is already on PATH.
  **Why:** python-dependent yt-dlp builds fail; `yt-dlp-wrap` npm package has ESM/CJS interop bugs.
- Any GCS access to the Replit object storage bucket MUST use the sidecar-authenticated client (external_account creds via `http://127.0.0.1:1106`), never plain `new Storage()` — that fails with "Could not load the default credentials".
- Concurrent JSON-in-bucket state (e.g. a manifest) needs compare-and-swap via GCS generation preconditions (`ifGenerationMatch` + retry on 412), or concurrent writers silently lose updates.
