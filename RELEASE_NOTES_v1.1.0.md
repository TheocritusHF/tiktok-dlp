# TheocritusHF tiktok-dlp v1.1.0

This feature release builds on v1.0.1 and brings the tested Instagram additions into
main. It includes the previous privacy patch and existing TikTok monitoring, photo
Stories, quality rechecks, LIVE recording and notification features.

## Changes and additions

- **Instagram extraction:** pin gallery-dl 1.32.16 and replace the old source patch
  with read-only upstream parser checks in CI and Docker builds. See [PR #7](https://github.com/TheocritusHF/tiktok-dlp/pull/7).
- **Best available video quality:** download Instagram DASH video/audio through an
  isolated, hash-pinned Python yt-dlp module. Measure actual saved dimensions and
  duration before persistence. Higher resolution is used when Instagram supplies
  it; 1080p is not guaranteed. The standalone TikTok binary is unchanged. See [PR #8](https://github.com/TheocritusHF/tiktok-dlp/pull/8).
- **Separate Instagram channels:** optional `DISCORD_INSTAGRAM_NEW_POSTS_CHANNEL_ID`
  and `DISCORD_INSTAGRAM_NEW_STORIES_CHANNEL_ID` route server-authorized copies
  alongside normal watch delivery, with scoped links and duplicate prevention.
  Empty settings never fall back to TikTok channels. See [PR #9](https://github.com/TheocritusHF/tiktok-dlp/pull/9).
- **Practical archive layout:** future Instagram Stories, posts and highlights use
  creator/type/UTC-day folders and descriptive timestamp/item filenames. Carousels
  retain ordered assets and ZIP packages under `_bundles`. Collision-safe creation
  and cleanup preserve sibling files. `INSTAGRAM_ARCHIVE_LAYOUT=legacy` retains
  the previous layout for future downloads. See [PR #10](https://github.com/TheocritusHF/tiktok-dlp/pull/10).
- **Existing archive migration:** an explicit offline CLI plans, applies, verifies
  and rolls back recorded Instagram path changes. It checks file sizes/hashes,
  backs up the database and originals, and rejects unsafe paths, missing media and
  deletion conflicts. Rollback preserves later database activity instead of
  replacing the whole live database. Existing ZIP contents remain byte-identical.
  See [PR #11](https://github.com/TheocritusHF/tiktok-dlp/pull/11).

## Installation and updating

For a new installation, follow the [fork installation guide](RELEASE_PREVIEW.md)
and check out the exact `v1.1.0` tag. GitHub supplies source ZIP/tar downloads;
this release does not attach a prebuilt Docker image or Windows installer.

For an existing installation, compare the running source, configuration, mounts and
local customizations before replacing anything. Back up SQLite state, media,
configuration and cookie files, and stop other archive writers before any migration.
A release or Git push does not automatically update your running local bot.

Dedicated Instagram channels need your own channel IDs. Instagram access may need
your own authenticated cookie export. Existing TikTok feature flags retain their
previous defaults. Existing lower-resolution media is not automatically replaced,
and existing archive files are not moved at startup. Migration is optional; follow
the [migration guide](docs/instagram-archive-migration.md) separately if wanted.

DASH videos can use VP9 with audio in MP4. Use a compatible player or prepared
Rewind playback. Daily date grouping uses UTC, matching existing archive dates.

## Privacy and compatibility

Main's persistent Instagram account cooldowns, limited subprocess environment,
cookie scoping and per-server link authorization are retained. New public examples
and fixtures contain no real cookies, tokens, private channel IDs or local runtime
paths. Migration plans/backups contain private archive data: keep them outside
served download folders, out of Git and release assets, and apply appropriate host
filesystem permissions. The `--offline` flag is an operator acknowledgement, not a
lock against independently running writers.

The v1.0.1 privacy fixes remain included. Older shared backups cannot be sanitized
by updating code; retain the precautions described in [v1.0.1 notes](RELEASE_NOTES_v1.0.1.md).
Rewind's access/authentication setup is unchanged. This release does not bundle a
Snapchat service or automatically change separate locally installed integrations.

## Validation

The combined local Node 22 backend suite passed 408 tests with zero failures and
one existing optional native-tool skip. Added coverage exercises real video/audio
fixtures, measured metadata, routing authorization, collision/persistence cleanup,
retention, WAL migration and targeted rollback. A LIVE test fixture now waits for
the committed journal file; LIVE production code is unchanged.

The release is published only after GitHub CI passes backend contracts, complete
Rewind lint/tests/build, desktop/mobile Chromium workflows and production backend
and Rewind image builds. Existing tags remain unchanged.
