# TheocritusHF tiktok-dlp v1.0.0

This is the first full release of the TheocritusHF fork. It combines the fork's proposed features (#23–#29) with the tested upstream main changes. It is a release of this fork, independent of upstream's releases. The tag is a fixed source snapshot; `main` and `release/combined-preview` may move later.

## Highlights

- Monitor and archive TikTok posts, video Stories, and photo Stories. Monitored photo Stories are saved as image ZIPs and use Story notifications.
- Optionally record watched TikTok LIVEs, with adaptive quality checks, webcast fallback, bounded reconnects, Discord notices, and restart recovery.
- Optionally recheck monitored video quality at 6, 24, and 72 hours. A replacement is staged and verified before the archive is changed. Successful upgrades retain the established Discord notice format.
- Route new post, Story, and confirmed quality upgrade notices to optional dedicated Discord channels.
- Include recent upstream Instagram/gallery-dl, download scheduling, and Rewind playback and dashboard improvements.
- Save media and SQLite state locally. GitHub deployment is manual on this fork; publishing or updating a branch does not replace a running Windows Docker container.

The optional LIVE, quality recheck, and dedicated-channel settings are disabled or unset by default. Configure them explicitly in `.env`.

## Install

Check out the exact tag, copy `.env.example` to `.env`, configure your Discord and Rewind settings, then build with Docker Compose. Follow the [fork installation guide](RELEASE_PREVIEW.md) for the complete setup and access instructions. GitHub supplies source ZIP and tar archives automatically; no prebuilt Docker image is attached to this release.

## Updating an existing installation

Back up the SQLite database, media, `.env`, and any cookie files before switching versions. The optional quality feature adds a database migration even if it stays disabled. Stop other processes using the same archive before migrating, and do not run two checkouts against one database or downloads directory. The release does not automatically update an existing container.

## Validation

The complete backend suite passed with 337 tests and one skip in the Docker trial. GitHub CI passed backend contracts, Rewind lint/build/tests, browser workflows, and backend and Rewind image builds. In the separate live trial, monitored downloads, Discord notices, a quality upgrade, and LIVE recording were observed working; 75 archive files passed the integrity check after the quality replacement fix.

The earlier `v0.1.0-preview.1` and `v0.1.0-preview.2` tags remain unchanged.
