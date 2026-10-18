---
name: Environment quirks (yt-dlp, object storage)
description: No Python in env; object storage requires Replit sidecar auth, not default GCS credentials
---
- Keep yt-dlp independent of system Python availability by using a checksum-verified standalone binary; Python availability has varied between environments.
  **Why:** Earlier Python-dependent setup failed, and `yt-dlp-wrap` had ESM/CJS interop bugs. Do not infer that Python is permanently unavailable.
- Any GCS access to the Replit object storage bucket MUST use the sidecar-authenticated client (external_account creds via `http://127.0.0.1:1106`), never plain `new Storage()` — that fails with "Could not load the default credentials".
- Concurrent JSON-in-bucket state (e.g. a manifest) needs compare-and-swap via GCS generation preconditions (`ifGenerationMatch` + retry on 412), or concurrent writers silently lose updates.
- Dev and the published app share the SAME bucket manifest. A running published instance with old code can run its own download job and fight the dev one (manifest write conflicts, stale statuses). After server-side download changes, tell the user to republish.

## YouTube access differs between environments

A successful playlist request from development does not prove that the published server can access it. Distinguish playlist-listing API failures from audio-stream failures before changing fallbacks.

**Why:** Published playlist API calls returned HTTP 403 while the same public playlist loaded in development. Earlier audio-client fallback work did not cover this different failure.

**How to apply:** Inspect the published error's stage, preserve the existing list on failure, and avoid promising that retries or an extractor update can overcome a server-side YouTube block.
