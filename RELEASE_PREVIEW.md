# Combined fork preview

This branch combines the proposed changes from seven upstream pull requests in
one installable checkout. The current prerelease snapshot is
[`v0.1.0-preview.2`](https://github.com/TheocritusHF/tiktok-dlp/releases/tag/v0.1.0-preview.2);
this is a fork preview, not an upstream release. The fork's default `main`
remains a documentation-only overview of these proposals.

| Area | Upstream proposal | Enabled by default? |
| --- | --- | --- |
| Automatic LIVE recording | [#23](https://github.com/nqrwhal/tiktok-dlp/pull/23) | No |
| Adaptive LIVE quality | [#24](https://github.com/nqrwhal/tiktok-dlp/pull/24) | No |
| Scheduled quality rechecks for monitored posts | [#25](https://github.com/nqrwhal/tiktok-dlp/pull/25) | No |
| Separate Discord archive and upgrade channels | [#26](https://github.com/nqrwhal/tiktok-dlp/pull/26) | Unset |
| Canonical monitored TikTok URLs | [#27](https://github.com/nqrwhal/tiktok-dlp/pull/27) | Yes; no setting |
| Webcast LIVE fallback and bounded reconnects | [#28](https://github.com/nqrwhal/tiktok-dlp/pull/28) | No |
| TikTok photo Story discovery and download | [#29](https://github.com/nqrwhal/tiktok-dlp/pull/29) | Yes; no setting |

PR #24 builds on #23; PR #26 builds on #25; PR #28 builds on #24. This
preview resolves those overlaps into one codebase. Upstream review of the
individual proposals is tracked on their PR pages.

## New installation with Docker Desktop

These PowerShell steps use a new directory and do not change another checkout:

```powershell
git clone --branch release/combined-preview --single-branch https://github.com/TheocritusHF/tiktok-dlp.git tiktok-dlp-combined-preview
Set-Location tiktok-dlp-combined-preview
Copy-Item .env.example .env
```

Edit `.env` and supply your own `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`,
`PUBLIC_BASE_URL`, `REWIND_PUBLIC_URL`, and a fresh `IMPORT_API_TOKEN`.
Set `REGISTER_COMMANDS_ON_START=true` for the first backend start if you
cannot run the command-registration script separately. Do not commit `.env`,
cookies, databases, or recordings. Read the main [README](README.md) for
Discord permissions, URLs, proxy/access configuration, and network exposure.

Validate the configuration, then build and start the default backend and
Rewind services:

```powershell
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --build
docker compose ps
```

After commands are registered, set `REGISTER_COMMANDS_ON_START=false` and
recreate the backend if desired. The optional Cloudflare tunnel uses the
separate `cloudflare` Compose profile and its own secret-file setup described
in the main README. Media and SQLite state reside under `./data` by default;
platform cookie jars, if used, reside under `./cookies`.

## Enable only the features you want

All optional flags in `.env.example` default to `false`; optional Discord
channels default to empty. Set only the features you want, then recreate the
backend with:

```powershell
docker compose --env-file .env up -d --build tiktok-discord-downloader
```

```dotenv
# Automatic LIVE recording requires watched TikTok accounts.
LIVE_RECORDING_ENABLED=true
# Optional additions to LIVE recording:
LIVE_ADAPTIVE_QUALITY_ENABLED=true
LIVE_WEBCAST_FALLBACK_ENABLED=true
LIVE_RECONNECT_ENABLED=true

# Scheduled quality rechecks for newly monitored TikTok videos:
QUALITY_UPGRADE_ENABLED=true

# Optional channels; supply actual Discord channel IDs to enable them:
DISCORD_NEW_VIDEOS_CHANNEL_ID=
DISCORD_NEW_STORIES_CHANNEL_ID=
DISCORD_QUALITY_UPGRADES_CHANNEL_ID=
```

Each LIVE addition requires `LIVE_RECORDING_ENABLED=true`. Adaptive recording
and reconnects preserve multiple parts rather than stitching them into one
file. Scheduled post quality rechecks run at 6, 24, and 72 hours when enabled
and only replace an archived video after a verified improvement. The canonical
TikTok URL and photo Story fixes require no setting. Photo Stories discovered
through monitoring are archived as image ZIPs and follow the existing Story
notification route. See the README's LIVE and quality sections
for timing, storage, and notification behavior.

## Existing installations

Make a verified backup of SQLite state, media, configuration, and any cookie
files before using an existing installation with this preview. The scheduled
quality feature adds a SQLite migration even when disabled. Test the preview
in an isolated checkout with its own `data` directory first, then follow the
project's [backup and recovery instructions](README.md#backups-and-recovery)
when moving an existing archive. Do not point two running checkouts at the
same SQLite database or downloads directory.

This preview branch can be updated when the individual PRs change. Use the
`v0.1.0-preview.2` tag for a fixed snapshot; the earlier `v0.1.0-preview.1`
tag remains at its original commit. The branch is not the upstream project's
installation branch; compare its commit and release notes before updating an
existing deployment.
