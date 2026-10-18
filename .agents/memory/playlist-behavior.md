---
name: Playlist display and bulk downloads
description: User expectations for switching playlists and downloading all tracks
---

Submitting a playlist URL should update the displayed songs to that latest playlist, not leave the previous playlist visible. “Download All” should save individual songs sequentially, with a three-second delay between device saves, across every page—not a ZIP.

Unfinished downloads should survive app restarts. Preserve intentional pauses and stops rather than restarting those automatically. Failed songs should show why YouTube rejected them, distinguishing YouTube restrictions from processing, storage, or network failures.

**Why:** The user explicitly requested the latest playlist, individual and recursive downloads, then clarified separate files with a three-second delay, restart recovery, and rejection explanations.

**How to apply:** Preserve these behaviors when changing the song list, scrape refresh, pagination, or download queue. Browser saves require an open tab and multiple-download permission; explain those limits instead of promising downloads while the browser is closed.

"Clear playlist" removes the list and saved queue but keeps song records and audio in storage. Song status must match real storage (done only if the file exists); the server reconciles at startup and at job start. A 404 "Song not downloaded yet" during Download All must auto-resume the server job and retry, not stop the queue.
