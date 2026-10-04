# Fork roadmap

This page tracks contributions proposed from this fork. Each proposal retains
its own feature branch for upstream review. The fork's `main` and
`release/combined-preview` branches contain the tested combined integration.
Use the upstream PR pages for current review and merge status.

## Submitted upstream

| Feature | Code branch | Upstream proposal | Relationship |
| --- | --- | --- | --- |
| Automatic LIVE recording | [`feat/automatic-live-recording`](https://github.com/TheocritusHF/tiktok-dlp/tree/feat/automatic-live-recording) | [PR #23](https://github.com/nqrwhal/tiktok-dlp/pull/23) | Foundation for #24 and #28 |
| Adaptive LIVE quality | [`feat/adaptive-live-quality`](https://github.com/TheocritusHF/tiktok-dlp/tree/feat/adaptive-live-quality) | [PR #24](https://github.com/nqrwhal/tiktok-dlp/pull/24) | Builds on #23 |
| Scheduled post quality rechecks | [`feat/automatic-post-quality-upgrades`](https://github.com/TheocritusHF/tiktok-dlp/tree/feat/automatic-post-quality-upgrades) | [PR #25](https://github.com/nqrwhal/tiktok-dlp/pull/25) | Independent of the LIVE proposals |
| Dedicated Discord archive and upgrade channels | [`feat/separate-discord-notification-channels`](https://github.com/TheocritusHF/tiktok-dlp/tree/feat/separate-discord-notification-channels) | [PR #26](https://github.com/nqrwhal/tiktok-dlp/pull/26) | Builds on #25 |
| TikTok monitored URL reliability | [`fix/tiktok-url-reliability`](https://github.com/TheocritusHF/tiktok-dlp/tree/fix/tiktok-url-reliability) | [PR #27](https://github.com/nqrwhal/tiktok-dlp/pull/27) | Independent fix; no new setting |
| Webcast LIVE fallback and reconnects | [`feat/webcast-live-reconnect`](https://github.com/TheocritusHF/tiktok-dlp/tree/feat/webcast-live-reconnect) | [PR #28](https://github.com/nqrwhal/tiktok-dlp/pull/28) | Builds on #24 and #23 |
| TikTok photo Story discovery and download | [`fix/tiktok-photo-stories`](https://github.com/TheocritusHF/tiktok-dlp/tree/fix/tiktok-photo-stories) | [PR #29](https://github.com/nqrwhal/tiktok-dlp/pull/29) | Independent fix; no new setting |

PR #24 includes the code from #23, PR #26 includes the code from #25, and
PR #28 includes the code from #23 and #24. Their GitHub diffs against upstream
`main` therefore show dependent changes until those earlier PRs are merged.
Review only the dependent changes in [#24](https://github.com/TheocritusHF/tiktok-dlp/compare/feat/automatic-live-recording...feat/adaptive-live-quality),
[#26](https://github.com/TheocritusHF/tiktok-dlp/compare/feat/automatic-post-quality-upgrades...feat/separate-discord-notification-channels),
or [#28](https://github.com/TheocritusHF/tiktok-dlp/compare/feat/adaptive-live-quality...feat/webcast-live-reconnect).

- #23 monitors watched TikTok accounts for LIVEs, records and archives footage,
  sends Discord notices, and recovers captured footage after a restart.
- #24 samples alternative LIVE formats without interrupting the active
  recorder, switches only after a verified quality improvement, and preserves
  all recording parts.
- #25 schedules quality rechecks for monitored TikTok videos at 6, 24, and 72
  hours. It replaces the saved file only after a verified resolution improvement.
- #26 can send new video, Story, and confirmed quality upgrade notices to
  separate Discord channels.
- #27 builds canonical monitored post URLs from a valid creator and post ID,
  including cached profile lookups.
- #28 checks verified webcast room data if yt-dlp reports offline and can
  reconnect a cleanly ended recorder to the same LIVE room for bounded attempts.
  It archives reconnected footage as separate parts.
- #29 discovers photo Stories in monitored profiles, saves image ZIPs, and
  routes notifications as Stories. It needs no new setting.

## Optional settings on feature branches

The settings below are examples from the indicated branches. A branch based on
an earlier PR also contains that PR's settings. See that branch's `README.md`
and `.env.example` for complete setup instructions.

| Setting | Example default | Purpose | Introduced in |
| --- | --- | --- | --- |
| `LIVE_RECORDING_ENABLED` | `false` | Enable automatic recording of watched LIVEs. | #23 |
| `LIVE_RECORDING_HANDLES` | empty | Limit recording to selected watched handles; empty uses all watched accounts. | #23 |
| `DISCORD_LIVE_CHANNEL_ID` | empty | Override the usual watch/subscription channels for LIVE notices. | #23 |
| `LIVE_POLL_SECONDS` | `120` | Time between LIVE discovery polls. | #23 |
| `LIVE_MAX_CONCURRENT` | `2` | Limit simultaneous LIVE recordings. | #23 |
| `LIVE_PROBE_CONCURRENCY` | `2` | Limit simultaneous LIVE discovery probes. | #23 |
| `LIVE_PROBE_TIMEOUT_SECONDS` | `35` | Limit how long a LIVE discovery probe can take. | #23 |
| `LIVE_MIN_FREE_GB` | `10` | Reserve free disk space before recording. | #23 |
| `LIVE_MAX_HOURS` | `8` | Cap the duration of one LIVE recording session. | #23 |
| `LIVE_ADAPTIVE_QUALITY_ENABLED` | `false` | Check for a better LIVE stream while recording. Requires LIVE recording. | #24 |
| `LIVE_QUALITY_CHECK_MINUTES` | `15` | Time between adaptive quality checks. | #24 |
| `LIVE_QUALITY_SAMPLE_SECONDS` | `20` | Duration of a candidate quality sample. | #24 |
| `QUALITY_UPGRADE_ENABLED` | `false` | Enable scheduled rechecks for monitored video posts. | #25 |
| `QUALITY_UPGRADE_POLL_MINUTES` | `15` | Time between checks for due upgrades. | #25 |
| `QUALITY_UPGRADE_BATCH_SIZE` | `2` | Limit upgrade jobs processed per polling cycle. | #25 |
| `DISCORD_NEW_VIDEOS_CHANNEL_ID` | empty | Additional channel for newly archived monitored videos. | #26 |
| `DISCORD_NEW_STORIES_CHANNEL_ID` | empty | Additional channel for newly archived monitored Stories. | #26 |
| `DISCORD_QUALITY_UPGRADES_CHANNEL_ID` | empty | Channel for confirmed quality improvements. | #26 |
| `LIVE_WEBCAST_FALLBACK_ENABLED` | `false` | Verify webcast room data when yt-dlp reports offline. | #28 |
| `LIVE_RECONNECT_ENABLED` | `false` | Try to continue a cleanly ended recorder in the same room. | #28 |
| `LIVE_RECONNECT_DELAY_SECONDS` | `2` | Wait before rechecking a LIVE for reconnect. | #28 |
| `LIVE_RECONNECT_MAX_ATTEMPTS` | `2` | Limit short same-room reconnects. | #28 |
| `LIVE_RECONNECT_STABLE_SECONDS` | `60` | Reset the short-reconnect count after a stable segment. | #28 |

The opt-in LIVE, post-upgrade, webcast, and reconnect features are disabled
by default; the dedicated Discord channels are unset. PRs #27 and #29 have no
new toggles. PR #28 still requires `LIVE_RECORDING_ENABLED=true` for its
optional LIVE behaviors to run.

## Combined fork preview

The [combined preview branch](https://github.com/TheocritusHF/tiktok-dlp/tree/release/combined-preview)
contains PRs #23–#29 together with the tested upstream integration, with a
separate [installation guide](https://github.com/TheocritusHF/tiktok-dlp/blob/release/combined-preview/RELEASE_PREVIEW.md).
The Docker backend test run passed 337 tests with one skip, and the live trial
confirmed quality upgrades, Discord notifications, and LIVE recording. The
[`v0.1.0-preview.2`](https://github.com/TheocritusHF/tiktok-dlp/releases/tag/v0.1.0-preview.2)
tag is a fixed earlier snapshot; the branch has newer changes. This is a fork
integration, not an upstream release. Its optional features remain disabled
until configured. Back up an existing archive before upgrading, since #25
adds a SQLite migration.

The fork's default `main` includes the combined feature code and this roadmap.
Individual PR branches remain separate for upstream review and can change
independently of the combined integration.

Fork-specific roadmap changes stay out of upstream feature PRs unless upstream
asks for them.
