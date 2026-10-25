# __YT Archiver__
Do you ever get tired of downloading each song from your YT playlist? 
Well, look no further, listening to music offline is about to get alot easier.
I'll be more than happy to offer a solution, YT Archiver. It's an open sourced project that I vibe coded that I offer to everyone for free.

Preview: [domain name unavailable untill October 28th 2026]

# Instructions
#### Step 1.)
Download this github repository

#### Step 2.)
Install Replit:
The first app you can publish is free.

#### Step 3.)
Attach the project ZIP to Replit Agent, then copy and send the prompt below.

---

Please import the attached YT Archiver ZIP into this Replit project and set it up until the app runs.

This is an existing React/Vite frontend and Express API in a pnpm workspace. Preserve its existing interface and behavior; do not replace it with a new scaffold or remove authentication. Before extracting, inspect the ZIP contents and the current project, check for unsafe paths and file conflicts, and stage the archive outside the workspace. Import the source while preserving current Replit-managed artifact manifests and workflows; use the artifact setup tools rather than editing managed manifests directly.

Set up the app's required services using Replit-managed tools: development PostgreSQL and its schema, Clerk sign-in, and App Storage for audio and archive data. Never bypass authentication to make the preview load. Do not ask me to paste credentials or print secret values; use the secure secrets flow for anything that truly requires a secret. Do not reuse a bucket ID or other platform configuration from the ZIP without verifying it belongs to this project.

Each remix gets its own Clerk users. Do not require a custom `sessionClaims.userId` template for a fresh app: preserve that verified claim when it exists for migrated accounts, and otherwise provision the local application account from Clerk's verified `auth.userId`.

Use pnpm and the versions recorded in the project lockfile. Check that the standalone, checksum-verified `yt-dlp` binary can install and that `ffmpeg` is available. Start the frontend and API workflows, run the project's type checks and existing tests, and verify the app preview and API health endpoint. Do not claim downloads work based only on the page loading; if YouTube access or another required service is blocked or unavailable, explain the exact limitation without bypassing access controls.

Preserve the existing playlist behavior, download queue recovery, separate track downloads, and clear-playlist semantics. Only download media the user has permission to save, and do not bypass DRM or access restrictions. Do not publish or deploy without asking me first.

When finished, summarize what was imported, what you configured, which checks passed, and any remaining setup needed from me.

---

#### Step 4.)
Wait until the replit agent is finsihed before you publish.
