# TheocritusHF tiktok-dlp v1.0.1

This patch release builds on the fork's v1.0.0 release. It contains the tested privacy fixes from [PR #5](https://github.com/TheocritusHF/tiktok-dlp/pull/5) without changing the Story, quality upgrade, LIVE recording, or Discord notification feature settings.

## Changes

- Restrict manually attached TikTok session cookies to HTTPS TikTok and known TikTok media hosts. Other photo and Story media URLs are fetched without the TikTok cookie jar.
- Persist only Instagram device identity in `data/instagram-device.json`. The next private listing sanitizes a legacy settings file that included session data.
- Keep the LIVE worker's temporary TikTok cookie copy outside the backed-up data directory and remove the old `data/live/private-cookies` directory when the LIVE worker starts.
- Bound Rewind's prepared playback copies to seven days by default, prune hourly, and clear prepared copies after successful archive trash and delete actions. Rewind may need to prepare a copy again on the next play. Original archived media stays in place.

## Updating an existing installation

Back up the SQLite database, media, configuration, and cookie files before replacing containers. Review older backups for `instagram-device.json` and `live/private-cookies`: updating source code cannot sanitize historical backup copies. Rotate the affected sessions if those backups were shared. The new release does not automatically update a running Windows Docker container, and it does not add application-level login to Rewind. Keep public Rewind access behind a private authentication proxy.

See the [installation guide](RELEASE_PREVIEW.md) and [backup instructions](README.md#backups-and-recovery). The original `v1.0.0` tag remains unchanged.

## Validation

PR #5 passed 339 backend tests with one skip and 29 focused Rewind bridge/core/playback tests. GitHub CI passed backend contracts, Rewind lint/tests/build, desktop and mobile Chromium workflows, and production image builds. The version-only release commit is validated separately by CI before tagging.
