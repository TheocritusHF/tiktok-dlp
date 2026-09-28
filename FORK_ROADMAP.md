# Fork roadmap

This page tracks optional TikTok LIVE work proposed from this fork. The code
for each submitted feature is on a separate branch. The default `main` branch
does not include these changes until it is explicitly updated.

## Submitted upstream

| Feature | Where to find the code | Upstream proposal |
| --- | --- | --- |
| Automatic LIVE recording | [`feat/automatic-live-recording`](https://github.com/TheocritusHF/tiktok-dlp/tree/feat/automatic-live-recording) | [PR #23](https://github.com/nqrwhal/tiktok-dlp/pull/23) |
| Adaptive LIVE quality | [`feat/adaptive-live-quality`](https://github.com/TheocritusHF/tiktok-dlp/tree/feat/adaptive-live-quality) | [PR #24](https://github.com/nqrwhal/tiktok-dlp/pull/24) |

The adaptive-quality branch includes automatic LIVE recording because PR #24
builds on PR #23. GitHub's PR pages show the current review and merge status.

- PR #23 monitors watched accounts for LIVEs, records them, archives completed
  footage, sends Discord notices, and recovers captured footage after a restart.
- PR #24 samples alternative LIVE formats during recording, switches only when
  the sample verifies better quality, and preserves every recording part for
  recovery and archive delivery.

## Optional settings on the feature branches

| Setting | Example default | Purpose | Available on |
| --- | --- | --- | --- |
| `LIVE_RECORDING_ENABLED` | `false` | Enable automatic LIVE recording for watched accounts. | PR #23 branch and PR #24 branch |
| `LIVE_RECORDING_HANDLES` | empty | Limit recording to selected watched handles; empty uses all watched accounts. | PR #23 branch and PR #24 branch |
| `DISCORD_LIVE_CHANNEL_ID` | empty | Override the usual watch or subscription channels for LIVE notices. | PR #23 branch and PR #24 branch |
| `LIVE_POLL_SECONDS` | `120` | Time between LIVE discovery polls. | PR #23 branch and PR #24 branch |
| `LIVE_MAX_CONCURRENT` | `2` | Limit simultaneous LIVE recordings. | PR #23 branch and PR #24 branch |
| `LIVE_PROBE_CONCURRENCY` | `2` | Limit simultaneous LIVE discovery probes. | PR #23 branch and PR #24 branch |
| `LIVE_PROBE_TIMEOUT_SECONDS` | `35` | Limit how long a LIVE discovery probe can take. | PR #23 branch and PR #24 branch |
| `LIVE_MIN_FREE_GB` | `10` | Reserve free disk space before recording. | PR #23 branch and PR #24 branch |
| `LIVE_MAX_HOURS` | `8` | Cap the duration of one LIVE recording. | PR #23 branch and PR #24 branch |
| `LIVE_ADAPTIVE_QUALITY_ENABLED` | `false` | Check whether a better LIVE stream format is available while recording. Requires LIVE recording. | PR #24 branch |
| `LIVE_QUALITY_CHECK_MINUTES` | `15` | Time between adaptive quality checks. | PR #24 branch |
| `LIVE_QUALITY_SAMPLE_SECONDS` | `20` | Duration of a candidate quality sample. | PR #24 branch |

See the `README.md` and `.env.example` on each branch for complete setup and
other LIVE settings. The defaults above leave automatic recording and adaptive
quality disabled unless explicitly enabled.

## Planned follow-ups

- Explore alternative webcast-based LIVE detection in a separate contribution.
- Explore reconnect handling for interrupted LIVE streams in a separate
  contribution.

These are plans, not implemented features of PR #23 or PR #24. Their scope and
timing may change as upstream reviews the existing proposals.

Fork-specific roadmap changes should stay out of upstream feature PRs unless
upstream asks for them.
