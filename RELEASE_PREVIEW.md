# TheocritusHF fork installation

[`v1.1.0`](https://github.com/TheocritusHF/tiktok-dlp/releases/tag/v1.1.0)
is the current feature release of this fork. It builds on v1.0.1 with Instagram
source-quality downloads, dedicated notification channels, descriptive daily
folders and an explicit offline archive migration. The existing TikTok features
and v1.0.1 privacy fixes remain included. See [release notes](RELEASE_NOTES_v1.1.0.md).
Use the tag for an exact source snapshot. This is a fork release, independent
of upstream's releases. The moving `release/combined-preview` branch may differ.

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
git clone --branch v1.1.0 --depth 1 https://github.com/TheocritusHF/tiktok-dlp.git tiktok-dlp-fork-v1
Set-Location tiktok-dlp-fork-v1
Copy-Item .env.example .env
```

To follow the moving integration branch instead, replace `v1.1.0` in the
clone command with `release/combined-preview`.

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

The optional LIVE and quality-upgrade flags default to `false`; optional Discord
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

# Optional dedicated Instagram channels:
DISCORD_INSTAGRAM_NEW_POSTS_CHANNEL_ID=
DISCORD_INSTAGRAM_NEW_STORIES_CHANNEL_ID=
```

Each LIVE addition requires `LIVE_RECORDING_ENABLED=true`. Adaptive recording
and reconnects preserve multiple parts rather than stitching them into one
file. Scheduled post quality rechecks run at 6, 24, and 72 hours when enabled
and only replace an archived video after a verified improvement. The canonical
TikTok URL and photo Story fixes require no setting. Photo Stories discovered
through monitoring are archived as image ZIPs and follow the existing Story
notification route. See the README's LIVE and quality sections
for timing, storage, and notification behavior.

## Instagram additions in v1.1.0

Export your own Netscape-format Instagram cookie file into `cookies/instagram.txt`
and set `INSTAGRAM_COOKIES_FILE=/app/cookies/instagram.txt` in `.env` when required.
Keep that file and `.env` private. Configure watches with the Instagram platform;
normal watch-channel delivery remains available without dedicated channel IDs.

New Instagram videos use the best available source video/audio. Resolution depends
on what Instagram supplies; 1080p is not guaranteed. DASH may produce VP9 video,
so use a compatible player or Rewind's prepared playback. Existing files are not
redownloaded automatically.

`INSTAGRAM_ARCHIVE_LAYOUT=daily` is the default for future Instagram downloads.
It groups files by creator, Stories/Posts/Highlights, and UTC date, with descriptive
item filenames. Set `legacy` to retain the old per-item layout for future downloads.
Existing archives do not move at startup. To reorganize recorded Instagram media,
read the [offline migration guide](docs/instagram-archive-migration.md); stop all
archive writers, plan, apply, verify and then restart. Backups contain private
media and database data and must stay outside served download folders.

## Existing installations

Make a verified backup of SQLite state, media, configuration, and any cookie
files before using an existing installation with this release. The scheduled
quality feature adds a SQLite migration even when disabled. Test the release
in an isolated checkout with its own `data` directory first, then follow the
project's [backup and recovery instructions](README.md#backups-and-recovery)
when moving an existing archive. Do not point two running checkouts at the
same SQLite database or downloads directory.

The `v1.0.0`, `v1.0.1` and `v1.1.0` tags are fixed. The `release/combined-preview`
branch may gain later changes, while the older `v0.1.0-preview.1` and
`v0.1.0-preview.2` tags remain at their original commits. Compare the exact commit with your
deployed version before updating an existing archive.
