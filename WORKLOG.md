# Project Work Log

This is the running engineering log for the multi-platform archive refactor. Keep it current as work lands so decisions, verification, and unfinished work survive across sessions.

## Goals

- Preserve the existing TikTok downloader, monitor, archive, Discord delivery, and Rewind behavior.
- Add Instagram and X/Twitter post saving, including images, videos, GIFs, carousels, and mixed-media posts.
- Represent posts with multiple ordered media assets instead of forcing every download into one video file.
- Support explicit links between profiles belonging to the same creator across platforms.
- Improve queue bounds, monitor delivery correctness, archive-read performance, security, recovery, CI, and deployment.
- Rename the project once the platform-neutral boundaries are in place and one new name can be applied consistently to packages, services, commands, docs, deployment, and UI.

## Decisions

- Platform identities remain distinct. A TikTok, Instagram, and X profile with the same handle are not assumed to be the same creator.
- Cross-platform relationships are explicit and reversible: platform profiles may belong to a shared creator group, and unlinking a profile must not remove its posts, watches, imports, or history.
- Post identity is `(platform, remote_post_id)`. Profile identity is `(platform, remote_profile_id)`, with a normalized handle used only as a lookup alias when a stable remote ID is unavailable.
- Existing rows will migrate as TikTok data.
- Direct post saving comes before Instagram/X profile imports and monitoring because individual-post extraction is the more stable platform surface.
- TikTok keeps its existing custom photo and story fallbacks. Instagram/X extraction will be isolated behind adapters with platform-specific cookie and proxy configuration.
- Extractor credentials must never be shared implicitly across platforms.

## Current Phase

The direct-save foundation, unified TikTok adapter path, versioned migrations,
durable monitor dead-letter flow, backend-owned Rewind reads, and operational
recovery/deployment gates landed on 2026-08-30. Rewind now has a separate
platform-neutral mixed-media library; authenticated Instagram/X smoke tests,
an immersive mixed-media feed decision, and the coordinated project rename remain.

## Completed

### 2026-09-02 — TikTok secUid monitor URL fix (live)

- TikTok watches with a cached `sec_uid` list via `tiktokuser:{secUid}`, and yt-dlp
  returns secUid-based post URLs (`/@MS4wLjABAAAA.../video/{id}`). The platform
  post/profile parsers only accepted 1-32 char handles, so every new post from
  an established watch was rejected as a profile/feed URL and dead-lettered
  after 5 tries (48 dead letters), and every deletion check on secUid rows
  spammed `A canonical TikTok post URL ... is required`.
- `parseTikTokPost`/`parseTikTokProfile` now accept secUid-style segments
  (preserved case-sensitively, null creator handle); playlist entries are
  rewritten to the human handle when yt-dlp reports one, so new `files` rows
  store canonical human URLs again.
- Cleared the 48 secUid-bug dead letters (backed up state first); the monitor
  re-queued and downloaded them with no new failures. Remaining dead letters
  (11) are TikTok story CDN 403s, and remaining deletion-check warnings are
  transient `TikTok blocked the current network path` IP blocks with 6h
  backoff — both TikTok-side, not parser bugs.
- Instagram: `hoyboanggg` posts list fine via the gallery-dl fallback;
  `meag_y_an` returns 0 posts/stories. The instagrapi private-API session is
  challenged (`login_by_sessionid failed: 467`), so refresh `cookies/instagram.txt`
  with a fresh logged-in browser export to restore private listings.
- `npm test`: 209 passed.

### 2026-09-02 — Instagram session refresh + private-API circuit breaker (live)

- Installed the fresh `cookies/instagram.txt` export (gitignored, 0600, old jar
  backed up to `/tmp/opencode`). The new `sessionid` still gets a 467 challenge
  from `i.instagram.com` (verified encoded and URL-decoded forms), so the block
  is network-context/challenge based, not a stale cookie. Repeated challenged
  logins risk flagging the account, so no further login hammering.
- Added a 30-minute circuit breaker in `src/platforms/galleryDl.js`: an
  `access_denied` private listing trips it, later listings go straight to the
  working gallery-dl fallback, and any private success closes it. Also guarded
  the fallback error paths against a null private error when the breaker is
  open. Verified live: both IG watches succeed with 0 failures and poll cycles
  dropped back to ~2s.
- `npm test`: 210 passed.

### 2026-09-02 — Instagram session re-login still blocked (account action required)

- Installed the post-logout/login `cookies/instagram.txt` export. Private API
  still 467s (`Unsupported` body, encoded and decoded sessionid) — the block is
  client-context based, not session freshness. Worse, the fresh session then
  started failing ALL web profile lookups via gallery-dl (`NotFoundError` even
  for @instagram), while TikTok and the rest of the monitor stay healthy with
  per-watch backoff isolating the IG failures.
- Pattern matches an Instagram suspicious-activity action block, likely
  triggered by the logout/login plus repeated challenged app-API logins from a
  datacenter IP. No code change can lift it. Required user action: open the
  Instagram app, approve any "suspicious login / was this you" checkpoint, and
  wait out any temporary block (typically 24-48h). Avoid extra manual
  login/logout cycles meanwhile. Re-test after approval with
  `gallery-dl --cookies cookies/instagram.txt --dump-json -- https://www.instagram.com/instagram/posts/`.
- Update: server is on the user's residential IP (basement), so IP reputation
  is unlikely. But the 4th same-account session is dead on arrival — direct
  web requests with its `sessionid` land on the logged-out `/` page, and even
  @instagram lookup 302s to login. Verdict: the account itself is flagged and
  Instagram is not honoring its sessions. Still needs a *different-account*
  session to confirm; repeated same-account re-logins only extend the flag.
- Update 2: different-account session (44750251157) works for web listings —
  old account confirmed flagged. Private instagrapi API still 467s regardless
  (app-device context rejected; gallery-dl fallback + breaker cover it).
  Findings with the good session: `hoyboanggg` is PRIVATE (new account must
  follow + be approved to restore monitoring), `meag_y_an` is public with 0
  posts / no active stories (nothing to catch — monitoring correctly idle).
  IG watch backoffs reset. No rebuild needed; cookies are read live.
- Update 3: instagrapi private API FIXED, no emulator needed. Root causes were
  both on our side: (1) every listing spawned a fresh Client with a random
  device fingerprint, so each poll looked like a new-device login (-> 467);
  fixed by pinning one stable Pixel 6 fingerprint in `/app/data/
  instagram-device.json` (600 perms, atomic writes, refreshed from
  `get_settings()` after login). (2) instagrapi dispatchers try public
  GraphQL/web first and hang retrying when the web tier refuses; the script
  now calls v1 private endpoints directly (`user_info_by_username_v1`,
  `user_medias_v1`, `user_stories_v1`). Verified live: login OK, lookups OK,
  meag posts return real (empty) data. hoyboanggg correctly returns
  "Not authorized to view user" (private + not followed).
- `npm test`: 211 passed.

### 2026-08-30 — Exact Instagram Story saves

- Added strict `/stories/{username}/{story-id}` parsing for pasted Discord URLs and `/download`, stripping share tracking parameters and assigning a collision-safe `story_{id}` archive identity.
- Reused the isolated Instagram gallery-dl transport for one exact story, preserved the creator and original story media ID, and persisted `story` as the normalized media type for Discord and Rewind.
- Required the platform-scoped Instagram Netscape jar and its `sessionid` cookie before story extraction, while keeping ordinary public Instagram posts cookie-optional and never sharing TikTok/X credentials.
- Added adapter, Discord ingress, command-manifest, archive, and Store persistence coverage for the supplied story URL shape.

### 2026-08-30 — Baseline audit

- Verified all Compose services are running and healthy.
- Verified 123 backend tests pass.
- Verified 44 web unit/integration tests pass and web lint is clean.
- Confirmed the worktree was clean before implementation began.
- Identified that metadata extraction currently occurs outside the bounded download queue.
- Identified that a successful monitor delivery can mark a post globally seen before all subscribed Discord destinations succeed.
- Identified that Rewind filters archive rows by `.mp4`, walks `.info.json` files, and spawns a SQLite CLI process for archive queries.
- Identified that CI exercises only the backend and production deployment recreates only the backend service.

### 2026-08-30 — Platform URL and identity foundation

- Added an adapter registry for TikTok, Instagram, and X/Twitter with exact official-host matching, canonical URLs, and strict credential-free HTTPS validation.
- Added normalized platform-scoped post references so identical remote post IDs cannot collide across platforms.
- Added normalized profile references keyed by stable remote profile ID when available, with platform-qualified handles available as discovery aliases for explicit creator-group linking.
- Defined optional adapter operations for metadata probing, downloading, creator listing, and availability checks without changing the existing TikTok runtime path yet.
- Added URL extraction and canonicalization helpers for later Discord and download-service integration while leaving the existing TikTok utility API intact.

### 2026-08-30 — Durable monitor fan-out

- Added per-subscription, per-event alert delivery records with durable success, failure, attempt, and error state.
- New-post and deletion alert fan-out now skips destinations that already succeeded and retries only failed destinations.
- Discord sends no longer mark a post globally seen; the monitor does that only after every current destination succeeds.
- Separated alert failures from extractor failures so repeated Discord outages cannot poison a post and suppress later retries.

### 2026-08-30 — Platform-neutral Discord ingress

- Discord messages and `/download` now accept canonical TikTok, Instagram, and X post URLs through the platform registry.
- Message URL recognition rejects HTTP, credential-bearing, lookalike-host, profile, and unsupported-path URLs before download work starts.
- Existing TikTok `vm.`, `vt.`, and `/t/<token>` short-post links remain supported through the shared download-source resolver.
- Preserved the existing three-post message cap, sequential result delivery, and progress updates across mixed-platform messages.
- Updated manual-save, help, command, and status copy for supported media while keeping `/watch` explicitly TikTok-only.

### 2026-08-30 — Cross-platform creator persistence

- Added platform profiles with stable `(platform, remote_id)` identity and a unique per-platform current-handle fallback, so URL-discovered profiles can gain a stable remote ID without changing their database identity.
- Added explicit creator groups and reversible one-group-per-profile membership; linking profiles from different existing groups requires `mergeGroups: true`, and a merge preserves every existing member.
- Profile handle changes resolved by stable remote ID retain creator-group and media-post associations across restart. Duplicate handle-only placeholders reconcile into the stable profile without losing either group.
- Added platform-scoped jobs and files with TikTok defaults for existing rows; `(platform, post_id)` file lookup prevents identical TikTok, Instagram, and X IDs from colliding while the legacy video lookup remains TikTok-compatible.
- Wired normalized media-post and ordered-asset persistence through the Store for download and cleanup integration.

### 2026-08-30 — Explicit Discord profile linking

- Added `/profiles link`, `/profiles show`, and `/profiles unlink` with strict TikTok, Instagram, and X profile URLs.
- Linking is always an explicit authorized action; matching handles across platforms never create a relationship by themselves.
- A link command can merge both profiles' existing creator groups without losing other members only with `merge:true`, and an optional name applies to the merged group.
- Link and unlink are archive-wide bot-owner operations, while showing a group is read-only and available without mutation permission.
- Unlinking removes only creator-group membership and preserves the platform profile, saved media, and TikTok watch state.

### 2026-08-30 — Bounded download admission and extractor work

- Global download capacity now counts every admitted manual, import, and monitor request from before metadata resolution through final delivery persistence.
- Metadata probes share the configured download worker pool instead of starting outside concurrency limits.
- URL-identity and normalized post-identity single-flight behavior still coalesce duplicate probes and downloads, while every caller retains its own delivery record.
- Monitor work continues to bypass requester quotas but no longer bypasses global capacity, preventing an unbounded burst of extractor probes.

### 2026-08-30 — Production-safe Instagram and X extraction

- Added direct Instagram post/reel/carousel and X status multi-media adapters backed by gallery-dl 1.32.10.
- Probe output uses gallery-dl's JSON message protocol with numeric IDs preserved as strings, then normalizes one post and its ordered image, video, or animated assets.
- Downloads use an owned staging directory, fixed filenames, subprocess timeout and abort handling, bounded stdout/stderr, asset count, per-item bytes, total bytes, and strict regular-file/path validation.
- Each platform has independent cookie and proxy settings. Cookie jars are copied, reduced to matching platform domains, and removed after extraction; gallery-dl receives a minimal child environment that excludes application secrets and ambient proxies.
- The shared download service now archives multi-asset results, packages galleries, persists normalized post/asset metadata, and keeps TikTok on its existing extractor path.
- The built-in adapter-to-service integration is covered through the real archive and SQLite paths, including a cached second request that creates a new delivery without another extractor invocation.

### 2026-08-30 — TikTok monitor platform isolation

- Scoped legacy `seen_videos` archive joins, permanent-token lookup, and creator-video purge planning to TikTok files.
- Removing or purging an Instagram/X file can no longer clear a same-ID TikTok deletion schedule; TikTok file removal retains the existing reset behavior.
- Deletion workers now require an active permanent TikTok archive link, so a same-ID Instagram/X save cannot make a TikTok post eligible for availability checks.

### 2026-08-30 — Scoped monitor delivery reuse

- Permanent monitor deliveries are now reused by archived file and destination scope, so Discord retries and service restarts keep one stable link instead of creating another job and token on every failed send.
- Different Discord scopes still receive independent permanent links, while manual and expiring deliveries keep their existing one-delivery-per-request behavior.
- Historical duplicate permanent links remain valid; the lookup uses the latest matching delivery and prevents new duplicates without invalidating URLs already posted to Discord.

### 2026-08-30 — Legacy Rewind platform boundary

- Kept the current MP4-only Rewind interface explicitly TikTok-only across video, creator, bookmark, statistics, media, thumbnail, trash, restore, and permanent-delete paths.
- Same-handle Instagram/X files and pre-existing bookmark or trash rows remain invisible and cannot be mutated through the legacy Rewind APIs.
- Download and link-history Store reads now return `platform`, so platform-neutral callers retain identity even when remote post IDs and handles match.
- Left the scheduled retention cleanup platform-neutral; this boundary limits the legacy Rewind product surface without preventing lifecycle cleanup for future multi-platform trash workflows.

### 2026-08-30 — Discord attachment budget and manual fallback

- Multi-asset and slideshow delivery now enforces every configured per-file limit plus a 24 MiB whole-message attachment budget, leaving margin below Discord's 25 MiB request cap.
- Manual slash-command and pasted-URL sends retry as link-only when Discord returns 40005 or HTTP 413, preserving the saved public URL and retention buttons.
- Archive-wide download purge now requires the configured bot owner; guild managers remain limited to purging their own requester-scoped downloads.

### 2026-08-30 — Transactional media persistence and lifecycle safety

- File rows, normalized media posts, and ordered asset rows now commit in one SQLite transaction; identity guards reject cross-platform file/profile attachment before it can corrupt cleanup or cache reuse.
- A failed platform archive commit removes only adapter-owned bytes that are confirmed absent from SQLite, while an ambiguously committed path is preserved for safe retry.
- Persisted extractor metadata is a small explicit schema; large format arrays, headers, signed CDN URLs, and other transient yt-dlp transport data are not retained in SQLite.
- Expiry, monitor-delete, and purge flows claim files before disk I/O. Link creation/extension cannot revive a claimed file, and finalizers revalidate claim state and active links before cascading records.
- Deleting the last asset prunes its orphaned media post, while a post shared by another saved file keeps its metadata.

### 2026-08-30 — Cross-platform security and contract hardening

- Cached Instagram/X results prefer the stored extractor identity over a stale or misleading handle in a post URL; platform labels now disambiguate matching handles and post IDs in Discord lists/history.
- Instagram probe parsing matches gallery-dl's real `audio=false` behavior: the extractor's directory count may include skipped music, while selected visual URL messages remain independently bounded.
- Cookie-backed instances are documented as private/single-tenant because permitted Discord users share the configured account session.
- Added `cookies` to `.dockerignore` so TikTok, Instagram, and X session jars never enter local or remote Docker build contexts.
- Renamed the monitor action to `Delete saved copy` so it describes local archive deletion rather than implying source-post deletion.

### 2026-08-30 — Durable monitor dead letters and manual retry

- Replaced in-memory post poisoning with durable SQLite failure state. Repeated TikTok monitor extraction failures now become a dead letter without inserting a false `seen_videos` row.
- Automatic scans suppress dead-lettered posts while keeping the original source identity, failure count, last extractor error, and retry history available across restarts and username changes.
- Added `/watch failures` and `/watch retry post_id:<id>` for authorized watch managers, with per-server/DM subscription scoping so one destination cannot inspect or retry another destination's failures.
- Manual retries download the stored post directly even when it has fallen outside the profile scan window. Success resolves the dead letter and delivers current alerts; failure returns it to the retry list with the new error.
- Store startup recovers an interrupted in-flight manual retry back to `dead_letter`, and `/status` exposes the current unresolved count.

### 2026-08-30 — Versioned SQLite migrations

- Added an ordered `schema_migrations` ledger and synchronized SQLite `user_version`; the existing idempotent upgrade path is recorded as v1 and monitor dead letters as v2.
- Pending migrations run one at a time in `BEGIN IMMEDIATE` transactions, so failed DDL and its ledger row roll back together while earlier completed versions remain intact and retryable.
- Startup validates consecutive application versions against immutable recorded names and refuses migration gaps or a database newer than the running binary instead of silently applying an unknown schema.
- Existing pre-ledger databases still run the full legacy column, index, ownership, subscription, platform-profile, and media bootstrap before receiving their baseline record.
- `/status` now reports the active database schema version, and tests cover idempotency, rollback/retry, history drift, unsupported future versions, and asynchronous migration rejection.

### 2026-08-30 — TikTok adapter runtime unification

- Added TikTok adapter operations for metadata probes, direct downloads, creator listing, story listing, and post availability while retaining the existing yt-dlp, cookie-copy, follower-photo, story, slideshow, naming, and archive implementations.
- DownloadService now dispatches probes and downloads through adapter capabilities for every platform. Legacy TikTok test/deployment injectors remain compatibility overrides rather than a separate production branch.
- Creator imports use the TikTok adapter for profile discovery and duration probes, and the monitor uses it for normal/burst scans, stories, and deletion availability checks.
- Adapter capabilities now describe probe timing, owned staging archives, creator-handle precedence, and the legacy TikTok file identity fallback, replacing platform-name conditionals in the materialization path without changing saved results.
- Added parity tests for canonical URL/config propagation, adapter dispatch ordering, creator-import operations, profile rejection, and availability results.

### 2026-08-30 — Rewind cross-platform profile management

- Added authenticated backend endpoints to list explicit creator groups, link profile URLs or known profile IDs, rename groups, add profiles, and reversibly unlink members without touching saved media or watches.
- Rewind's live bridge exposes only the intended GET, POST, PATCH, and DELETE methods for those routes and forwards them through the existing private admin hop; it does not provide a generic backend proxy.
- Added a responsive creator-dashboard manager for TikTok, Instagram, and X profile URLs, including explicit merge confirmation, optional shared names, inline rename/add controls, direct source links, and reassignment of known unlinked profiles.
- Matching handles remain inert. Duplicate spellings of one profile cannot create a one-member group, and omitting a name while extending an existing group preserves its current name.
- Added backend, bridge, rendered-contract, and in-memory browser workflow coverage. Playwright execution remains unavailable on this host until its Chromium bundle is installed; the browser test itself is checked by lint and the production build.

### 2026-08-30 — Backend-owned Rewind archive reads

- Moved Rewind creator, video, bookmark-filter, exact-file, and statistics SQL into Store methods on the backend's long-lived SQLite connection; the bridge no longer spawns a `sqlite3` process for each archive request.
- Added authenticated `/api/rewind/*` backend contracts with bounded limits and validated keyset cursor fields, while preserving the browser-facing response shapes, legacy creator IDs, metadata sidecar enrichment, row caches, and TikTok-only visibility boundary.
- Added partial active-TikTok indexes as schema migration v3 for global and per-username Rewind ordering. Existing databases apply the indexes atomically through the migration ledger.
- Removed the SQLite CLI and `LIVE_DB_PATH` from the Rewind image/runtime. Rewind still mounts media read-only for byte-range delivery and thumbnail generation, but the backend is now the sole database owner.
- Added Store, HTTP, query-contract, and live-bridge integration coverage, including proof that IDs returned in a page serve from the row cache without a second backend lookup.

### 2026-08-30 — Platform-neutral Rewind media library

- Added schema migration v4 with active-media ordering indexes and a backend-owned Rewind post query that filters by platform, profile, creator group, exact file, bookmark state, and stable keyset cursor.
- The authenticated `/api/rewind/posts` contract returns normalized creator/group identity and ordered content assets while retaining package metadata for delivery; legacy rows receive a safe synthetic primary asset.
- Added browser-facing `/api/posts`, `/post-media/:fileId/:assetIndex`, and `/post-download/:fileId` routes. The bridge strips filesystem paths, uses bounded row caches, constrains content types, supports byte ranges, forces package downloads, and keeps media access inside the archive root.
- Added a responsive Media dashboard for TikTok, Instagram, and X images, videos, animations, galleries, archives, and mixed posts, including platform/search filters, ordered-asset navigation, source links, and package downloads.
- Added dedicated platform-neutral post bookmark mutations, optimistic card controls, and a bookmark-only Media filter. Instagram/X bookmarks persist in the shared file-keyed table while the legacy `/api/bookmarks` list remains TikTok/MP4-only.
- Added confirmed platform-neutral trash and restore mutations plus Active/Trash Media views. Restoration verifies the package and every recorded asset still exist, trash preserves bookmarks, and trashed asset/package routes remain unavailable until restoration.
- Kept permanent deletion out of the new Media UI. The existing retention worker already claims and purges trashed files across platforms with shared-path protection, while legacy immediate-delete routes remain TikTok-only.
- Hardened lifecycle failure and race handling: incomplete galleries stay in trash, a concurrent cleanup claim returns a retryable conflict, failed browser mutations keep their confirmation and current row intact, and successful responses must confirm both the action and file ID.
- Verified scheduled retention against a real Instagram package with ordered assets, including bookmark/link/database cascades and preservation of a shared asset still referenced by an active X post.
- Bounded bridge row-cache freshness to 30 seconds so an out-of-band trash or purge cannot leave media indefinitely eligible for serving; mutations made through Rewind still invalidate every relevant cache immediately.
- Updated the production same-origin gateway for the new asset routes and added Store, HTTP, bridge integration, rendered-contract, gateway, and strict in-memory browser coverage. Playwright execution still requires the browser bundle that CI installs.

### 2026-08-30 — Operational recovery and full-stack delivery gates

- Added dependency-aware backend readiness backed by a live SQLite probe and schema version; Rewind readiness now fails when either the backend or read-only archive mount is unavailable.
- Restricted browser CORS responses to the configured Rewind origin and exact loopback development origins, while keeping Cloudflare Access as the actual authentication boundary.
- Added WAL-aware online SQLite snapshots with source/copy integrity checks, SHA-256 sidecars, restrictive permissions, and bounded retention. A tested restore command verifies the selected snapshot, preserves the replaced database first, and requires explicit stopped-service confirmation.
- Production deployment now targets the exact commit that passed CI, refuses stale rollback, builds backend and Rewind while the old stack is online, backs up before migrations, recreates both services together, and waits for both health checks without restarting `cloudflared`.
- CI now gates deployment on backend tests/contracts, Rewind lint/unit/integration/build checks, desktop and mobile Chromium workflows, Compose validation, and both production image builds. Browser execution remains unavailable on this host because its Playwright Chromium bundle is not installed, but CI installs it explicitly.

## Verification Log

| Date | Check | Result |
| --- | --- | --- |
| 2026-08-30 | `npm test` | 123 passed |
| 2026-08-30 | `cd web && node --test tests/*.test.mjs` | 44 passed |
| 2026-08-30 | `cd web && npm run lint` | Passed |
| 2026-08-30 | `docker compose ps` | Backend, Rewind, and cloudflared healthy/running |
| 2026-08-30 | `node --test test/index-alert.test.js test/monitor.test.js test/discord-ui.test.js test/config-files-store.test.js` | 74 passed |
| 2026-08-30 | `node --test test/platforms.test.js` | 6 passed |
| 2026-08-30 | `node --test test/discord-ingress.test.js test/commands.test.js test/discord-ui.test.js test/config-files-store.test.js test/platforms.test.js` | 62 passed |
| 2026-08-30 | `npm test` | 141 passed |
| 2026-08-30 | `node --test test/creator-profiles-store.test.js test/config-files-store.test.js` | 43 passed |
| 2026-08-30 | `node --test test/commands.test.js test/discord-profiles.test.js test/discord-ingress.test.js test/config-files-store.test.js` | 49 passed |
| 2026-08-30 | `npm test` | 157 passed |
| 2026-08-30 | `node --test test/gallery-dl.test.js test/platforms.test.js` | 10 passed |
| 2026-08-30 | `npm test` | 158 passed |
| 2026-08-30 | `docker compose config --quiet` | Passed |
| 2026-08-30 | `docker compose build tiktok-discord-downloader` | Passed; gallery-dl 1.32.10 installed and version-checked |
| 2026-08-30 | `npm test` | 161 passed |
| 2026-08-30 | `node --test test/gallery-dl.test.js test/platforms.test.js test/download-service.test.js` | 18 passed |
| 2026-08-30 | `npm test` | 162 passed |
| 2026-08-30 | `node --test test/download-service.test.js test/index-alert.test.js test/config-files-store.test.js` | 51 passed |
| 2026-08-30 | `npm test` | 164 passed |
| 2026-08-30 | `node --test test/http-server.test.js test/config-files-store.test.js` | 48 passed |
| 2026-08-30 | `cd web && node --test tests/*.test.mjs` | 44 passed |
| 2026-08-30 | `cd web && npm run lint` | Passed |
| 2026-08-30 | `cd web && npm run build` | Passed |
| 2026-08-30 | `npm test` | 169 passed |
| 2026-08-30 | `node --test test/discord-ui.test.js test/discord-ingress.test.js test/config-files-store.test.js` | 63 passed |
| 2026-08-30 | `node --test test/discord-ui.test.js test/discord-ingress.test.js test/config-files-store.test.js test/discord-profiles.test.js` | 68 passed |
| 2026-08-30 | `node --test test/config-files-store.test.js test/platform-monitor-store-isolation.test.js` | 48 passed |
| 2026-08-30 | `npm test` | 179 passed |
| 2026-08-30 | `cd web && node --test tests/*.test.mjs` | 44 passed |
| 2026-08-30 | `cd web && npm run lint` | Passed |
| 2026-08-30 | `cd web && npm run build` | Passed |
| 2026-08-30 | `find src test -name '*.js' -print0 | xargs -0 -n1 node --check` | Passed |
| 2026-08-30 | `docker compose config --quiet` | Passed |
| 2026-08-30 | `git diff --check` | Passed |
| 2026-08-30 | `node --test test/platforms.test.js test/download-service.test.js test/creator-import.test.js test/index-alert.test.js` | 32 passed |
| 2026-08-30 | `npm test` | 190 passed |
| 2026-08-30 | `cd web && node --test tests/*.test.mjs` | 44 passed |
| 2026-08-30 | `cd web && npm run lint` | Passed |
| 2026-08-30 | `cd web && npm run build` | Passed |
| 2026-08-30 | `find src test -name '*.js' -print0 | xargs -0 -n1 node --check` | Passed |
| 2026-08-30 | `docker compose config --quiet` | Passed |
| 2026-08-30 | `git diff --check` | Passed |
| 2026-08-30 | `node --test test/migrations.test.js test/monitor-failures-store.test.js test/config-files-store.test.js` | 51 passed |
| 2026-08-30 | `npm test` | 187 passed |
| 2026-08-30 | `cd web && node --test tests/*.test.mjs` | 44 passed |
| 2026-08-30 | `cd web && npm run lint` | Passed |
| 2026-08-30 | `cd web && npm run build` | Passed |
| 2026-08-30 | `find src test -name '*.js' -print0 | xargs -0 -n1 node --check` | Passed |
| 2026-08-30 | `docker compose config --quiet` | Passed |
| 2026-08-30 | `git diff --check` | Passed |
| 2026-08-30 | `node --test test/commands.test.js test/discord-monitor-failures.test.js test/monitor.test.js test/monitor-failures-store.test.js` | 28 passed |
| 2026-08-30 | `npm test` | 184 passed |
| 2026-08-30 | `cd web && node --test tests/*.test.mjs` | 44 passed |
| 2026-08-30 | `cd web && npm run lint` | Passed |
| 2026-08-30 | `find src test -name '*.js' -print0 | xargs -0 -n1 node --check` | Passed |
| 2026-08-30 | `git diff --check` | Passed |
| 2026-08-30 | `npm test` | 203 passed |
| 2026-08-30 | `cd web && npm test` | Production build passed; 51 tests passed |
| 2026-08-30 | `cd web && npm run lint` | Passed |
| 2026-08-30 | `find src test scripts -name '*.js' -print0 | xargs -0 -n1 node --check` | Passed |
| 2026-08-30 | `node --check web/scripts/live-bridge.mjs web/scripts/live-bridge-core.mjs web/scripts/start-live.mjs web/scripts/start-live-core.mjs` | Passed |
| 2026-08-30 | `docker compose config --quiet` | Passed |
| 2026-08-30 | `bash -n scripts/deploy-prod.sh` | Passed |
| 2026-08-30 | Parse `.github/workflows/*.yml` with PyYAML | Passed |
| 2026-08-30 | `git diff --check` | Passed |
| 2026-08-30 | Focused Playwright mixed-media workflow | Build/server passed; browser launch unavailable because the local Chromium bundle is not installed |
| 2026-08-30 | `npm test` | 204 passed |
| 2026-08-30 | `cd web && npm test` | Production build passed; 54 tests passed |
| 2026-08-30 | `cd web && npm run lint` | Passed |
| 2026-08-30 | `cd web && npx playwright test --list` | 96 desktop/mobile tests discovered; TypeScript test loading passed |
| 2026-08-30 | `find src test scripts -name '*.js' ... node --check` plus bridge/gateway `.mjs` checks | Passed |
| 2026-08-30 | `docker compose config --quiet` and `docker compose ps` | Passed; backend and Rewind healthy, cloudflared running |
| 2026-08-30 | Deploy shell syntax, workflow YAML parse, and `git diff --check` | Passed |
| 2026-08-30 | `npm test` after exact Instagram Story support | 206 passed |

## Rename Follow-up

The current repository, package, service, commands, deployment checks, and documentation are TikTok-named. Do not rename only one layer. Choose the new name, then change all of these together with compatibility notes for operators and existing Discord commands.

Candidate direction: keep **Rewind** as the product name and use a descriptive repository/package name such as `rewind-media-archive`. Final naming remains undecided.

## Next Work

- Run authenticated Instagram/X smoke tests in the private production environment without exposing session material.
- Decide whether mixed-media posts belong in the immersive feed and whether Media needs an explicitly confirmed immediate permanent-delete action in addition to automatic retention cleanup.
- Choose the final project name, then rename repository, package, service, deployment, Discord, and UI surfaces together.

## 2026-09-11 Rewind Playback

- Preserve adjacent video players and their buffers; limit speculative loading to one successor's metadata after the active clip has enough data. Drag seeking commits once on release, and background/foreground transitions preserve playback intent.
- Render video pages independently of creator metadata and totals, cancel obsolete pagination requests, and request five dashboard previews instead of 500. Wait for the first bookmark page before selecting its initial card.
- Cancel upstream gateway streams when the viewer disconnects or swipes away. Resolve cold media requests directly instead of first loading 500 archive rows.
- Verified 215 backend tests, 58 web unit/integration/rendered tests, TypeScript, lint, and 42 focused browser cases across desktop Chromium, mobile Chromium, and WebKit, including real H.264 decoding. CI installs ffmpeg for the real-video fixture.
- Rebuilt and restarted the app and Rewind; both are healthy, Discord logged in, and the next monitor cycle completed with zero polling failures. Cloudflared was left running.
- Deployed-gateway testing at 3 Mbps and 4x CPU throttling observed no stalls or dropped frames and a 33 ms return to the retained player. An isolated installed Chromium PWA rendered in actual standalone mode and played, sought, and reloaded successfully. These checks used a local proxy to the deployed gateway, not a physical phone or the authenticated public tunnel.
- The broad browser suite still has eight unrelated failures: two desktop table-ARIA checks, three native-download fixture cases, and three profile-link locator cases. Their affected markup/fixtures predate these changes; all focused playback cases pass.

## 2026-09-13 Buffering Follow-up

- Removed the readiness-before-play gate: mobile browsers can defer preload until playback is requested, so waiting for a decoded frame before calling `play()` can deadlock startup. The poster still waits for an actual presented frame.
- Unresolved buffering or a missing first frame exposes an explicit retry after 15 seconds. There is no automatic retry loop; a retry reloads the source within the user's playback gesture.
- Retired players explicitly pause and release their sources. Stable video refs preserve adjacent buffers during ordinary renders. Scroll-position selection also follows large jumps through virtual spacers, with one direction-aware incoming player warmed speculatively.
- The two clips near the report in tunnel logs (2769 and 2768) are faststart H.264 MP4s with correct range responses; complete local gateway reads took 6-7 ms. The sampled production clip played in Chromium and WebKit. These clips are clues, not a user-confirmed reproduction of the stuck video.
- Real H.264 regressions verify playback is requested while response headers are held, decoding after release, seeking, buffer retention, and rapid forward/reverse traversal across virtual windows. The authenticated public tunnel and the user's physical device remain unverified; local success does not establish TikTok-equivalent performance.
- A stricter deployed WebKit check exposed a second defect: recycling native snap targets midway through a feed could jump past the intended card and retire its buffered player. Lightweight snap points now stay mounted while the seven visible content cards and at most three video players are recycled. Late offscreen `playing` events also pause their player immediately.
- Bookmark pagination temporarily releases snapping while inserting a page, then positions its first new card. This prevents Safari from following the old footer past the newly loaded videos.
- The final focused suite passes all 72 cases across desktop Chromium, mobile Chromium, and mobile WebKit. The real retained-player regression starts at index 12 in a 36-video feed and asserts active identity and paused offscreen players, closing the first-page-only coverage gap. Both WebKit regressions also passed three consecutive isolated runs. All 58 web unit/integration/render tests, TypeScript, and lint pass.
- Rebuilt and restarted only `rewind-web`; the service is healthy. The stricter local-proxy check against the deployed gateway now retains the archived player across a WebKit return swipe with all other players paused. Backend and tunnel services were left running.

### HEVC Compatibility Follow-up

- An actual archived HEVC clip (1522) advanced audio but decoded zero video frames in Chromium, with repeated waiting/playing transitions. Those transitions also restarted the missing-first-frame deadline. The watchdog now tracks the combined unresolved condition, so they cannot keep its timeout alive indefinitely. Removed redundant playback requests from `loadeddata` and `canplay`; returning-player readiness also requires decoded video dimensions.
- Versioned playback URLs now prepare cached H.264/AAC faststart copies of incompatible sources, with proper HDR-to-SDR tone mapping and bounded dimensions/bitrate. Compatible MP4/H.264/AAC files bypass encoding. Downloads override playback selection and remain byte-identical to archived originals. Failed conversions never serve incompatible originals under the playback URL.
- Conversion runs one at a time with at most three admitted jobs, shares concurrent range requests, and skips queued clips whose viewers have disconnected. Prepared files publish atomically, are protected during serving, and use source size/mtime/path plus encoder-version cache keys. The existing size/age-limited cache now survives rebuilds in a named Compose volume. `If-Range` prevents stale partial-byte reuse after a representation changes.
- Verified 66 web unit/integration/render tests, TypeScript, lint, and Compose validation. Seven conversion tests also passed inside the production image, including HDR HLG/PQ, Matroska, dimensions, cache reuse, and failed-output cleanup. The focused native-touch/watchdog suite passed 43 cases with two intentional non-CDP skips; eight trusted touch gestures with native snapping stayed within three players/seven heavy cards.
- Deployed only `rewind-web`. Through the local HTTPS proxy at 3 Mbps, 100 ms latency, and 4x Chromium CPU throttling, clip 1522 produced its first decoded frame in 12.83 seconds on a cold conversion and 3.86 seconds using the prepared copy. The prepared run advanced 29.90 seconds in 30 seconds, decoded 899 frames with zero dropped frames or rebuffers, and produced a decoded frame 46.4 ms after a five-second backward seek. One preliminary warm audit lost its browser process and produced no valid measurement; the repeated completed run passed. These are deployed-gateway measurements, not an authenticated public-tunnel or physical-phone result.
- Prepared all nine identified HEVC clips through the deployed media route: 1522, 1668, 985, 964, 941, 921, 901, 877, and 42. All returned 200 and their cached playback copies total 36,255,494 bytes; archived originals were not modified.
- Unthrottled Linux WebKit presented clip 1522's first frame at 521 ms and continuously presented 432 frames over 15 seconds without rebuffering. Its timeline unexpectedly wrapped after about eight seconds despite a 60-second duration. This reproduced with `loop=true` in a bare video element, through an independent range server, and with the fixed-30-fps prototype; the same deployed copy without `loop` advanced normally through 12 seconds. It is not an eight-second startup stall or a demonstrated fractional-frame-rate defect. No speculative encoder change was made. The native-loop issue remains unresolved and physical Safari behavior remains unverified. Artifacts: `/tmp/rewind-webkit-origin-1522.json` and `/tmp/rewind-webkit-loop-prototype.json`.

### Complete Loops and Canceled Swipes

- Replaced the feed's native `loop` flag with one `ended` handler using the existing guarded playback function. There is no browser detection or explicit seek: `play()` restarts an ended element. A bare-player comparison played the full 60.012-second archive clip in Chromium and WebKit, restarting in 1.9 ms and 154 ms respectively. The active, visible, unpaused checks prevent late ended events from restarting offscreen or paused players.
- Deterministic queue tests exposed abandoned conversions retaining their queue slots and returning false 503 responses to newly selected clips. The existing limiter now accepts cancellation for queued work. Abandoned entries are removed immediately; running encodes and surviving shared range requests remain intact. Conditional single-flight cleanup prevents an old cancellation from deleting a replacement request. All three queue tests passed ten consecutive runs.
- A longer deployed WebKit run exposed a false buffering timeout after a successful loop: the engine kept emitting frames without a second `playing` event after `waiting`, and Rewind paused itself 15 seconds later. First-frame observation now belongs to the buffering watchdog, where an actual presented frame immediately cancels the deadline and clears buffering. Removed the old event-owned frame callback. Real missing frames still reach Retry within the fixed deadline.
- The focused playback suite passed 52 cases with two intentional non-CDP skips. After the final immediate-timer-cancellation adjustment, all 39 UI/watchdog cases passed again. The complete web build and all 69 unit/integration/render tests, TypeScript, lint, Compose validation, and diff checks pass.
- Rebuilt only Rewind; backend and tunnel stayed running, and all nine prepared copies survived in the persistent cache. The deployed Chromium check at 3 Mbps/100 ms/4x CPU still reached its first decoded frame in 3.87 seconds, decoded 899 frames over 30 seconds without rebuffering or drops, and resumed a backward seek in 53 ms.
- The final deployed WebKit feed check ran for 82 seconds with untouched media streaming through a local HTTPS gateway proxy. It presented its first frame at 636 ms, played the full minute without early wrapping, restarted in 156 ms, and reached 21.61 seconds into the next play with 2,435 presented frames, no error, and no false pause. This resolves the observed native-loop and post-loop timeout defects in that environment; physical Safari and the authenticated public tunnel remain unverified. Before/after artifacts: `/tmp/rewind-webkit-before-frame-recovery-1522.json` and `/tmp/rewind-webkit-after-frame-recovery-1522.json`.

### Archive-wide Playback Preparation

- Read-only probing of all 2,304 active TikTok MP4s found 146 HEVC videos and two audio-only slideshow tracks, rather than only the nine HEVC clips previously identified. All probes completed. The two largest HEVC files (2212 and 1624) are roughly six minutes long; their production conversions took 60.74 and 58.55 seconds. Prepared all 146 HEVC copies through sequential production HEAD requests without changing archived originals.
- Removed age-based eviction for prepared playback copies while retaining the 5 GiB size limit, active-stream protection, and normal expiry for thumbnails and cached originals. This prevents otherwise reusable copies from requiring conversion again after seven days. Source fingerprints and encoding versions still isolate replaced files and changed output recipes.
- The current first feed page is H.264, but high-bitrate clip 3303 rebuffed twice and advanced only 3.32 seconds during a five-second test at 3 Mbps/100 ms/4x CPU. Compatible sources above 2.2 Mbps now also receive bounded playback copies. Public URLs advance to `playback=2`; the unchanged encoder retains its version-one disk keys, so the HEVC backfill survives the policy update. Tests cover reported and computed bitrates, the exact threshold, unknown-rate passthrough, downloads, and rejection of old playback URLs.
- Prepared all 147 additional high-bitrate candidates through sequential production HEAD requests, with no failures. The deployed probe passed through one borderline source (3076); the other 146 produced copies. The final persistent cache contains 292 completed playback files totaling 1,197,195,703 bytes and no partial files, below the existing 5 GiB bound.
- Slideshow soundtracks 2965 and 3253 have explicit `vcodec: none` sidecars. The video API now omits these records after slicing the page, preserving cursor progress even across an empty page. Original downloads remain available. The downloader's final fallback now rejects explicitly audio-only formats, allowing the existing slideshow resolver to run instead of storing a soundtrack as a video.
- Left the metadata scan and ingestion architecture alone: the measured page API took 4-27 ms, all sidecars parsed in 107 ms, and the newest 500 files had no HEVC. No background transcoding service or scheduled warmer was added.
- Verified all 215 backend tests, 72 web unit/integration/render tests, TypeScript, lint, Compose validation, and 61 focused browser cases with two intentional non-CDP skips. Rebuilt the backend and Rewind; both are healthy, Discord logged in, and the next monitor cycle completed with zero polling failures. The existing deletion-check rate-limit warning remains unrelated. Cloudflared stayed running.
- With the prepared copy, clip 2212 reached its first decoded frame in 5.13 seconds on the throttled connection and decoded 899 frames over 30 seconds with no drops or rebuffers. The deployment reused that same file under playback policy two without re-encoding it. Clip 3303's first frame remained about 4.42 seconds, but it advanced 4.91 of five seconds with zero rebuffers/drops and resumed a backward seek in 18.6 ms. Clip 3307 decoded 878 frames across repeated loops over 30 seconds without drops or rebuffers, starting in 3.38 seconds. Unthrottled WebKit presented 3303 in 484 ms, restarted in 89 ms, and continued through 25 seconds without a false pause or alert. These local gateway results do not verify the user's exact failing clip, authenticated public path, or physical device.

### Startup Transfer Reduction

- Removed the Google font loaders in favor of system fonts. Vinext 0.0.50 ignores `preload: false`, so this deletes eleven forced font downloads instead of adding another loading mechanism. Enabled the framework's existing `--precompress` build option for static JavaScript and CSS. Only active and immediately adjacent feed posters mount; offscreen lazy images were competing with the first video request.
- On a fresh mobile Chromium context at 3 Mbps, 100 ms latency, and 4x CPU throttling, the same initial clip (3294) presented its first frame in 1.387 seconds, down from 2.634 seconds. A final-deployment repeat measured 1.384 seconds. Before that first frame, font transfer fell from 148,923 bytes to zero, CSS from 70,193 to 15,046 bytes, and JavaScript from 342,925 to approximately 112,043 bytes. Pinned clip 3307 improved from 3.337 to 1.803 seconds. These are local HTTPS proxies to the deployed gateway, not public-tunnel or physical-phone timings.
- Compression tests verify the generated files are smaller and decompress byte-identically. Poster tests verify the two initial and three adjacent images. Reviewed and updated the mobile visual snapshot for the expected native-font glyph changes; no layout overflow or overlap appeared. No bundle-splitting refactor, dependency, or background warmer was added.

### Rebuffering Deadline Follow-up

- Reproduced another infinite-wait defect after a successful first frame: subsequent `playing` events cleared buffering and reset the 15-second deadline even when no new video frame arrived. Removed that event-driven reset for browsers with video-frame callbacks. Actual presented frames now resolve both initial loading and later rebuffering; older browsers retain the existing dimensional fallback.
- The new regression failed against the preceding deployed logic, then passed in desktop Chromium, mobile Chromium, and mobile WebKit. All 58 focused playback/browser cases pass, with two intentional non-CDP skips; the production build, all 73 web unit/integration/render tests, TypeScript, and lint also pass. An initial direct unit-test invocation reused the browser suite's live-mode build and failed six fixture-render expectations; rerunning the supported `npm test` command rebuilt the correct fixture mode and passed all 73.
- Rebuilt only `rewind-web`; it is healthy, and the backend and tunnel were left running. Server checks found all 292 playback copies intact, valid initial ranges in 3-58 ms, and eighteen forward/backward/suffix ranges in 1-8 ms. All 2,009 compatible originals already have faststart metadata; no further server or encoding changes were justified.
- Final deployed WebKit playback of 3307 presented its first frame in 343 ms and 724 frames over 25 seconds, completing three loops with a 78 ms first restart and no alerts or false pause. The engine still emitted `waiting` and `stalled` while presenting frames, which confirms why actual frame delivery must resolve buffering. Inspected the rendered mobile screenshot. Artifact: `/tmp/rewind-webkit-final-rebuffer-3307.json`.
- Public routing, generated media origins, and tunnel ingress agree on `rewind.yufei.dev`. The tunnel has four healthy connections and no recent errors, but unauthenticated media requests redirect to Access, so the actual authenticated browser path remains unverified. Old tabs retaining `playback=1` URLs receive HTTP 400 until a full reload obtains version-two URLs; there is no service worker. Neither finding establishes the user's reported stall as resolved.
- Separately, holding the initial video API response reproduces indefinite `Loading videos...` before any player exists. Archive and bookmark reads have cancellation but no response deadline. This is an outstanding robustness gap, not a confirmed explanation for a video already shown as buffering. Requested the failing browser and exact URL instead of adding speculative server changes or claiming TikTok-equivalent behavior.

### Feed Loading Recovery and Retained Tabs

- Added one shared 15-second JSON request deadline, including response-body parsing, for archive and bookmark requests. It cancels the underlying transport and distinguishes a timeout from navigation/unmount cancellation without requiring newer AbortSignal composition APIs. Bookmark timeouts do not trigger the existing automatic retry schedule, and failed hydration/migration preserves local IDs and migration state.
- Reproduced the empty-feed error being mislabeled `No saved videos` when creator metadata succeeded, and pagination errors being hidden inside the collapsed toolbar. Removed that duplicate warning UI and its CSS. Failed initial loads now use the empty-state error and Retry; errors after playback starts use the existing feed toast, with a busy state during pagination retry.
- Manual retry requests only failed resources. Retrying a cursor page preserves accumulated pages, the active video element, playback position, and scroll offset; successful pagination clears its error. Creator metadata has an independent refresh revision so retrying a failed creator lookup cannot discard later video pages. Regression coverage verifies these guarantees from the second feed page.
- Resolved the previously noted stale-link failure: known `playback=1` requests now issue an uncached, same-origin 307 redirect to `playback=2`, instead of HTTP 400. Distinct URLs and current If-Range validation keep changed representations separate. HEAD/range redirects are covered, unknown versions remain rejected, and download requests still return byte-identical originals.
- All 83 web unit/integration/render tests, TypeScript, lint, and diff checks pass. The expanded Chromium/WebKit suite passed 108 cases across loading recovery, bookmarks, retained players, seeking, fast scrolling, loops, and visuals, with six intentional platform skips. Rebuilt and restarted only Rewind; it is healthy, while the backend and tunnel remained running.
- A real deployed-gateway test held the first video API response: the error appeared at 15.543 seconds, and Retry presented an actual archived frame 296 ms later, with exactly two list requests. Inspected the mobile error screenshot. Artifact: `/tmp/rewind-live-loading-recovery.json`.
- Actual legacy media URLs followed their redirects and decoded successfully: Chromium presented the first frame in 173 ms and 294 frames over ten seconds, while WebKit presented it in 533 ms and 282 frames. Both completed a loop and remained playing without alerts. Artifacts: `/tmp/rewind-webkit-legacy-chromium-3307.json` and `/tmp/rewind-webkit-legacy-webkit-3307.json`. These browser checks use a local HTTPS proxy and are not authenticated public Access tests.
- Public-tunnel testing through an existing permanent Discord link transferred a 15.24 MB archived original at 38.6 Mbps with a 67 ms first byte. Initial, near-end, backward, and repeated-start ranges matched the original bytes and had valid 206 responses; first-byte times were 47-157 ms. Cloudflare reported DYNAMIC, so these were not edge-cache hits. The test used the server's connection and the bot's public-file route, not the user's phone or Rewind's Access-authenticated route; it does not explain or resolve the reported physical-device stall.
- The remaining goal verification still requires the failing device/browser and exact page or media request. No such response has arrived. Local success, working redirects, and healthy public-tunnel throughput do not establish TikTok-equivalent playback on that device.

### Sound Persistence and Download Efficiency

- The user reports improved mobile playback and asks for mute/unmute to follow subsequent clips. Removed the effect that persisted every mute-state transition; only explicit sound toggles now write the preference. Automatic muted autoplay remains available on a fresh page, but cannot override a sound/play gesture in the current session. A gesture revision also prevents a late rejected playback promise from undoing a newer choice.
- Added forward/backward/remount, autoplay-rejection, remembered-startup, and stale-promise regressions. The real-media fixture now includes AAC audio, closing the previous silent-video coverage gap. All 73 focused browser cases pass across desktop Chromium, mobile Chromium, and mobile WebKit, with two intentional non-CDP skips. All 83 web tests, TypeScript, and lint pass.
- Rebuilt and restarted Rewind; it is healthy. Deployed-gateway checks in Chromium and WebKit kept audio unmuted across six distinct active players after one trusted sound tap, then kept it muted on backward/forward navigation after muting. Playback advanced without alerts or offscreen audio. Chromium used trusted touch swipes; Linux WebKit used programmatic scrolling after trusted taps. These are not physical-iOS tests. Artifacts: `/tmp/rewind-audio-policy-chromium.json` and `/tmp/rewind-audio-policy-webkit.json`.
- Deleted `cl.request_timeout = 15` from the Instagram private helper. In installed instagrapi 2.1.5 this property is a sleep before every private request, not an HTTP timeout; the library's default one-second pacing remains intact. No concurrency, polling intervals, or failure backoffs were raised. Before deployment, no-download monitor cycles repeatedly took 185-199 seconds, with a 209-second outlier. The first deployed cycle checked all 30 watches in 45.206 seconds with zero polling failures; subsequent smaller due-watch cycles took 20.768, 10.673, and 9.776 seconds. Watch counts differ, so the shorter partial cycles are not a matched speedup benchmark. Existing two-profile TikTok story-identity warnings remain.
- Canonical archive links with persisted media metadata now reuse the local file before entering the extraction queue. Tests complete cached delivery in roughly 1-3 ms while another extractor is deliberately held, without an upstream request or redownload. Missing files, trash, platform mismatches, short links, and legacy records without persisted metadata retain their existing resolution path; legacy slideshow captions, duration, and image paths are covered. No archive backfill or new cache was added.
- Fresh complete TikTok metadata now reaches yt-dlp through its existing `--load-info-json` interface, avoiding a second extraction of the same page. Format choice, cookies, limits, and output options remain unchanged. Private temporary info files (0700 directory, 0600 file) are removed before output collection or photo fallback, including on errors. Incomplete metadata, stories, and slideshows keep their existing paths. `--abort-on-error` enables the info loader's native expired-URL recovery; no custom retry loop was added.
- All 225 standard backend tests passed, with the opt-in native case tested separately in the rebuilt production image without external networking. The native fixture used two requests/621 ms for URL extraction versus one request/417 ms for supplied formats; an expired URL refreshed successfully in 639 ms, and an unavailable source exited with failure. These fixture timings are not a TikTok-network speedup measurement.
- A single real TikTok download through the deployed code fetched metadata in 2.694 seconds and downloaded the 1,683,909-byte clip in another 1.021 seconds (3.715 seconds total). The download subprocess used info reuse and the byte count matched the archived original. Output went to a temporary directory and was removed; the archive/database were not modified. No old-path repeat was made, so this verifies the new path rather than an end-to-end before/after ratio.
- Rebuilt and restarted the backend; it is healthy and Discord logged in. Rewind stayed healthy and cloudflared was not restarted. Final diff checks pass.

### Legacy Cache Reuse and First-delivery Scheduling

- Extended archive-first reuse to older TikTok records without `media_posts`. The service reads only the existing `<post-id>.info.json` beside the selected file, validates its identity/title/platform, and retains display fields without copying expired download formats. Missing, malformed, incomplete, mismatched, and oversized sidecars fall back to the existing probe path. No new cache, directory scan on requests, or database backfill was added.
- An initial same-basename inventory found 1,222 matching sidecars. Using the downloader's post-ID naming also located all 34 slideshow ZIP sidecars. The final read-only audit verified existing media plus valid metadata for all 1,256 legacy records: 1,212 MP4s, 34 ZIPs, and ten other files. All 34 ZIPs retain image counts; all 32 eligible for inline image delivery have their expected image files. The largest sidecar is 64,494 bytes, below the one-MiB read guard.
- Reproduced head-of-line delay caused by separately queuing metadata and media work: three requests ran `probe A, probe B, probe C, download A, download B, download C`. A held later probe prevented the first delivery despite its metadata already being ready. Each worker now retains one request through extraction and saving, producing `probe A, download A, probe B, download B, probe C, download C`. Canonical request sharing happens before admission to the worker, and resolved aliases still share the in-flight asset. Global/per-user admission limits and concurrency are unchanged.
- The scheduling regression failed before the change and now delivers the first fixture about 10-12 ms after its metadata while the later probe remains held. This is a controlled ordering proof, not a real-network download-time benchmark. Tests also cover one/two-worker alias coalescing, distinct delivery tokens, concurrency bounds, and recovery after probe/download failures.
- All 237 standard backend tests pass; the opt-in native test is skipped there. All 53 focused downloader/service tests, including native expired-URL recovery, pass inside the rebuilt Node 22 production image with external networking disabled. The legacy sidecar regressions also failed against the previous behavior before passing with the new path.
- In an isolated run of the deployed image with networking disabled and the real archive mounted read-only, files 2103, 2102, and 2101 reused their local metadata in 3.19, 0.89, and 1.27 ms, with zero upstream calls and matching titles/descriptions/durations. All job state was confined to an in-memory Store; the archive/database were unchanged. Reusable check: `/tmp/rewind-legacy-cache-audit.mjs`.
- Rebuilt and restarted only the backend. It is healthy, Discord logged in, and the next monitor cycles completed with zero polling failures (17.068 and 10.486 seconds for differing due-watch sets). Rewind and cloudflared remained running. Existing TikTok story-identity and deletion-check rate-limit warnings remain outside these changes. No new physical-device playback parity claim is made.

### Single-process Canonical TikTok Downloads

- Compared 1,112 retained flat import entries with full archived sidecars before considering monitor metadata pass-through. Every listing lacked a thumbnail; 168 videos had empty listing titles, and all 85 slideshows appeared as video entries. Passing those listings unchanged would lose display metadata, so monitor wiring remains unchanged.
- Known TikTok post URLs now use the existing `probeBeforeDownload: false` adapter capability. yt-dlp extracts and downloads in one process; the downloader reads its matching post-ID sidecar before calculating the archive directory and returning display metadata. This removes one Python startup and cookie-staging cycle, not another upstream extraction request: supplied-format reuse had already eliminated that duplicate request.
- Skeletal requests reject absent, corrupt, mismatched, or incomplete sidecars before moving output. Caller-owned files are retained on failure, while owned staging is removed. Both slideshow fallback paths run before video-sidecar validation and preserve the requested creator. Video, slideshow, and story results expose the extracted publication timestamp; slideshow results retain the resolved soundtrack duration.
- Short links still probe for identity, full supplied formats still use native info-file loading, and legacy TikTok files without usable cached metadata still probe to recover their captions. Canonical request coalescing, queue/admission limits, and other platforms remain unchanged. No new cache, background worker, polling rate, or download concurrency was added.
- The initial new regressions failed before the downloader change. All 246 standard backend tests pass, with the optional native case skipped there. All 70 focused service/adapter/downloader tests pass in the rebuilt Node 22 image with external networking disabled, including native expired-URL recovery. Independent cross-file review found no remaining regression.
- Rebuilt and restarted only the backend. It is healthy, Discord logged in, and subsequent due-watch cycles completed without polling failures (3.214 and 2.267 seconds for small due-watch sets, not full-cycle benchmarks). Rewind and cloudflared remained running.
- The deployed single-process path downloaded archived clip 3312 into temporary storage with an in-memory Store: 1,683,909 bytes, no metadata probe, one yt-dlp process, matching captions/duration/publication date, a thumbnail, and the requested creator. Its first run took 14.975 seconds. A subsequent same-clip comparison measured 3.117 seconds through the two-process probe/info-reuse path and 3.155 seconds through the single-process path. These samples verify reduced process work, not an end-to-end network speedup. All temporary media and database state were removed; the real archive/database were unchanged. Reusable checks: `/tmp/rewind-single-pass-download-audit.mjs` and `/tmp/rewind-current-download-audit.mjs`.
- A later log check recorded two Instagram gallery-dl polling failures in one cycle, followed by successful due-watch cycles, plus the previously observed TikTok story-identity and deletion-check rate-limit warnings. These warnings remain unresolved; healthy app readiness and the successful initial cycles do not imply that every upstream poll succeeds.

### Instagram Listing Failure Isolation

- Read-only inspection found that all four Instagram watches had repeated failures, but retained diagnostics only said `gallery-dl failed to extract the post`. Independently reproduced a scope bug: any private `access_denied`, including `Not authorized to view user` for one creator, opened a 30-minute account-wide circuit breaker and diverted unrelated creators to gallery-dl.
- Private helper errors now carry a validated failure stage through the Node wrapper. Only an access denial during login opens the global breaker; creator lookup and content permission failures stay local. Genuine login denial still pauses repeated logins for 30 minutes, and a successful private listing still closes the breaker. Existing per-watch retry/backoff behavior is unchanged.
- Deleted the story helper's exception-swallowing fallback to `Client.story_medias`, which is absent from installed instagrapi 2.1.5. A failed private story request now reaches the existing gallery fallback/error path instead of falsely reporting an empty successful listing. Tests distinguish real empty stories from failures at login, lookup, and each content endpoint.
- Failed gallery fallbacks retain the private failure kind and stage in their message without adding upstream URLs, credentials, headers, or response bodies. Existing error-selection precedence remains unchanged.
- The creator-isolation regression failed against the previous production image (`shouldSkipPrivateListings()` unexpectedly became true after a creator denial), then passed against the rebuilt image. All 251 standard backend tests pass, with the optional native yt-dlp case skipped. All 43 focused listing/monitor/platform-isolation tests pass inside the rebuilt production image with external networking disabled.
- Rebuilt and restarted only the backend; it is healthy, Discord logged in, and the next due-watch cycles completed with zero polling failures. Rewind and cloudflared remained running.
- A bounded deployed-code audit used a temporary copy of the existing device/session settings and did not change watches, jobs, or archived media. `hoyboanggg` failed at the private posts stage in 5.451 seconds; its gallery fallback also failed, taking 17.326 seconds total. The following `0kviv` request still attempted private listing (3.980 seconds), proving the first creator did not open the global breaker, but its post request and gallery fallback also failed (13.079 seconds total). Both checks left the private breaker closed. Later scheduled failures for `vivianerrss` and `meag_y_an` now report `Private API: access_denied (posts)`, rather than losing that diagnosis. These fixes do not establish restored Instagram acquisition: all four currently receive content-read failures despite completing login/lookup.
- Reviewed TikTok's remaining download work without changing it. The installed yt-dlp thumbnail fetch is synchronous before video transfer, but Rewind consumes the local thumbnail before resorting to ffmpeg poster generation. Removing it could delay first viewing and change posters, so no deletion was justified without stage timings. Description output is a tiny local write, not another network request; info JSON is required by ingestion and Rewind. No further upstream TikTok benchmark was run in this turn.

### Instagram Action-rate Backoff

- One bounded private listing with credential-redacted diagnostics established the underlying failure: `feedback_required: We limit how often you can do certain things on Instagram to protect our community. Tell us if you think we made a mistake.` The request failed at the posts stage in 4.036 seconds. The broad `required` match had mislabeled this action-rate block as `access_denied`; the preceding logs did not prove a creator-permission problem. The audit used temporary session/device settings and left watch/archive state unchanged (`/tmp/rewind-instagram-error-audit.mjs`).
- Independent read-only inspection of installed instagrapi 2.1.5 confirmed that `FeedbackRequired` escapes its posts wrapper as a `PrivateError`. That exception does not provide a reliable HTTP status, response headers, or Retry-After. Only the observed combination of `feedback_required` and `we limit how often` now gains the retryable `rate_limited` classification; unrelated feedback messages are not assumed to be throttles.
- Confirmed private throttles now start a shared 30-minute listing pause that stops both Python requests and gallery-dl fallback for posts, stories, and highlights. This duration reuses the application's existing cooldown policy; it is not an Instagram-provided retry time. Locally rejected attempts do not refresh the deadline, and a concurrent successful request does not clear it. Login-denial fallback behavior and creator-specific isolation remain unchanged. The existing per-watch backoff remains responsible for scheduling; no new worker, timer, or database schema was added.
- The exact-feedback fixture failed before the change, then passed with one initial Python call, no gallery fallback, no subprocesses on later requests during cooldown, and normal private listing at the original deadline. All 253 standard backend tests pass, with the optional native yt-dlp case skipped. All 45 focused listing/monitor/isolation tests pass in the rebuilt Node 22 production image with external networking disabled. Diff checks pass.
- Rebuilt and restarted only the backend; it is healthy and Discord logged in. No further live Instagram probes were made after the confirmed throttle. Existing watch backoff timestamps were inspected read-only and left unchanged, so recovery remains unproven until normal polling succeeds after the platform restriction lifts. Rewind and cloudflared remained running.

### Same-poll Instagram Identity Reuse

- Removed duplicate creator lookups from follow-up private listings. The monitor passes an identity derived directly from the current posts result to burst, story, and optional highlight requests. The first posts request in every poll still resolves the handle; manual listings remain unchanged. This saves one target-profile request for each eligible follow-up, not a measured end-to-end download-time percentage. Highlights forwarding is tested but provides no live savings because the entrypoint does not currently wire that optional method.
- Hints require an Instagram platform, matching handle, and positive decimal string ID. Python validates the optional ID before authentication and skips only the username lookup. Session validation, error stages, gallery fallback, polling cadence, and concurrency remain unchanged. Missing metadata cannot borrow the stored watch ID, large IDs stay strings, and fresh identity is reusable even when there are no posts. No persistent cache, schema, worker, or session-restoration shortcut was added.
- The new wrapper, Python, and monitor regressions failed against the prior behavior, then passed with reuse enabled. All 257 standard backend tests pass, with one optional native yt-dlp test skipped. All 49 focused listing/monitor/isolation tests passed with networking disabled in the Node 22 production environment, then passed again against the rebuilt image. Independent review found no actionable issue; diff and Compose checks pass.
- Rebuilt and restarted only the backend. It is healthy, Discord logged in, and subsequent due-watch cycles completed with zero polling failures. An existing TikTok story-identity warning still appears. Rewind and cloudflared remained running. No live Instagram diagnostic requests were made; scheduled polling still encountered the known throttle before deployment, and recovery is not established. The deployment preserves per-watch backoff, while the existing process-local shared cooldown resets on restart.
- Rechecked the deployed audio implementation independently: explicit mute/unmute is shared across next/previous and remounted players, with real-audio browser regressions already recorded above. The focused preference unit test passed again. No additional frontend change or physical-phone parity claim was made.

### TikTok Download-stage and Story-poll Audit

- Timed one real canonical download of the same bounded archive clip 3312 through the deployed service, using an in-memory Store and temporary download directory. The installed yt-dlp API was instrumented only in a temporary wrapper to emit stage names and elapsed times; URLs, headers, cookies, and response bodies were not logged. The request retained zero retries, a 45-second deadline, and a 20-MB limit. It produced the expected 1,683,909 bytes with matching title, description, duration, and thumbnail metadata, then removed temporary media and database state. The archive and persistent database were not modified.
- Total elapsed time was 2,783 ms with one subprocess. Python/library startup reached extraction at 383.69 ms; extraction reached media processing at 1,413.32 ms. Description output took 0.08 ms, thumbnail writing/fetching took 653.02 ms, and video transfer took 654.40 ms. This is one instrumented live sample, not a before/after speedup or latency percentile. Reusable isolated checks remain in `/tmp/rewind-download-stage-audit.mjs` and `/tmp/rewind-ytdlp-stage-timing.py`.
- Left thumbnail acquisition intact: Rewind uses the downloaded cover before attempting a video-frame poster, so deleting it would change displayed posters and move work into first viewing. Description output is negligible local work. No custom parallel thumbnail downloader, modified yt-dlp production wrapper, worker, or dependency was added.
- Independent offline story traces confirmed that cached active/unknown stories use one API request, cached empty stories use one profile request, and an empty-to-active transition uses profile then API. A renamed-creator fixture showed that the profile path refreshes identity even with no stories. Deleting that branch would lose coverage, while newly discovered video downloads already start before story checks complete. Four focused story/monitor tests passed; production polling cadence and implementation were left unchanged.
- The prior goal turn made progress by deploying same-poll Instagram ID reuse. This audit supplies stage evidence for leaving the remaining TikTok paths unchanged; it does not establish physical-device playback parity or Instagram recovery. No live Instagram probe or service restart was performed.

### 2026-09-30 — Instagram session recovery and extractor updates

- Installed the user-tested Instagram cookie export with existing owner-only permissions; the previous jar is retained under gitignored `.secrets/instagram.pre-refresh-*.txt`. Restored `0kviv` using Vivian's existing Instagram subscription scope. Existing archive state was preserved; normal new-watch baselining handles old posts.
- Updated pinned gallery-dl 1.32.10 to 1.32.14 (upstream Instagram posts/reels, stories/highlights, and lookup fixes) and instagrapi 2.1.5 to 3.0.16 (response normalization and authentication diagnostics fixes). Updated the README version. Rebuilt/restarted only the backend; installed versions verified, readiness healthy, Discord logged in.
- All 257 backend tests passed (one optional skip); 43 focused Instagram/gallery/monitor tests passed offline in the new image. Compose validation and diff checks passed. All four Instagram watches completed scheduled polls on the new image with zero failure counts. A recovered hoyboanggg post completed download and Discord delivery.
- Recovery is partial: Vivian story `3997083979677336073` is discoverable but the production gallery-dl probe fails with `KeyError: 'width'` on 1.32.14. Confirmed through the app's actual probe with staged cookies; normal retries remain in place. A plain gallery-dl simulation succeeded but does not use our `videos=merged` selection and therefore does not establish download compatibility. No speculative library patch or global media-format change was made. Investigate missing dimensions in Instagram merged-video metadata before claiming story downloads fully restored.

### 2026-09-30 — Story parser repair and Instagram account protection

- Reproduced gallery-dl 1.32.14's `KeyError: width`: Instagram merged video variants contain type/URL but no width/height. Added `scripts/patch-gallery-dl.py`, applied during image build, to report missing variant dimensions as unknown (0) while preserving the chosen MP4. Version/source guards require review on upgrades. The actual installed extractor fixture fails before the patch and passes afterward for missing dimensions, known dimensions, and image Stories without networking.
- Instagram creator polls now serialize at a minimum 15-minute interval (about 93% fewer scheduled polls than the former minute cadence); TikTok cadence stays unchanged. Instagram poll failures back off 15 minutes to six hours. Story-list failures propagate instead of recording a false successful empty poll. Shared cooldown deadlines override shorter watch backoffs.
- Confirmed throttles pause Instagram listings/probes/download extraction for six hours; login/security/account-review restrictions pause them for 24 hours. State persists in `DATA_DIR/instagram-account-cooldown.json`; local rejections do not prolong it and concurrent successes cannot clear it. Gallery fallback and immediate HTTP retries stop during restrictions. The instagrapi handler now raises challenges instead of automatically attempting resolution and resending; verified against installed 3.0.16 with networking disabled. These durations are conservative local policy, not upstream guarantees.
- Fixed download-failure records to preserve platform and manual retry to select the platform's watch. Corrected only the two targeted Vivian Story failure rows (`3997083979677336073`, `3997143107082804356`) and allowed one recovery attempt each. Both downloaded through the deployed monitor, files exist, both Discord deliveries are `delivered`, and their failure states are `resolved`. ffprobe confirms both are valid 720x1280 H.264 videos with AAC audio (8.106 and 8.126 seconds). Vivian's persisted next-check deadline is exactly 15 minutes after the successful poll. Other historical mislabeled failure rows were not bulk-modified.
- Verification: 264 backend tests passed, one optional skip; 56 focused tests passed in the built image with external networking disabled; actual parser and installed-client challenge handling checked; Compose/diff validation passed. Rebuilt/restarted only the backend; healthy and Discord logged in. Rewind and cloudflared stayed running. The README contains the operating strategy and patch upgrade instructions. No new recurring monitor or platform service was introduced.
