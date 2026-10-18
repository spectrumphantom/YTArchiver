---
name: Playlist display and bulk downloads
description: User expectations for switching playlists and downloading all tracks
---

Submitting a playlist URL should update the displayed songs to that latest playlist, not leave the previous playlist visible. “Download All” should process every song sequentially, not just the visible page.

**Why:** The user explicitly reported stale playlist results and requested individual downloads plus recursive downloading of every song.

**How to apply:** Preserve these behaviors when changing the song list, scrape refresh, pagination, or download queue.
