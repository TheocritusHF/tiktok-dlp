# Same username on Instagram and TikTok

You can watch the same username on both sites. Each watch keeps its own last check,
successful check, next check and failure backoff. A TikTok poll must never postpone
the Instagram watch or make it appear to have checked successfully.

## What the failure looks like

Older or customized installations can retain a username-only timing update. When
two platforms share a username, that update can write to the wrong watch row.
Repeated TikTok checks can then keep postponing Instagram, even when its active
Stories are accessible. The Instagram row can show recent successful checks while
its Stories have no download, seen record or notification attempt.

This repository already updates watch outcomes by **platform plus username**.
The monitor supplies the platform on successful polls, profile failures and watch
normalization failures. The regression tests in
`test/monitor-same-name-watches.test.js` exercise the actual monitor and an in-memory
SQLite store together, including download and alert callbacks. They cover repeated
TikTok polls, each platform's failure backoff and a forced Instagram run.

## Check an affected installation

1. Confirm that Instagram cookies are configured and readable, and that a listing
   through the installed adapter returns the currently active Stories.
2. Compare both platform watch rows. A recent Instagram success alongside an
   overdue TikTok row for the same username can indicate that timing updates are
   being written to the wrong row; the timestamps alone do not prove discovery.
3. Inspect the actual running `src/state/store.js` and `src/tiktok/monitor.js`.
   Outcome updates must use both platform and username, and the monitor must pass
   the platform. Installed files can differ from the image or the repository,
   particularly when custom source is bind-mounted.
4. After a reviewed correction, use `/watch run` with the username and platform
   **Instagram**, or allow a complete monitor cycle. Verify an actual new Story
   archive and its Discord notice. An already archived or expired Story is not a
   reliable new-download test.

Polling intervals, network delays and account-wide Instagram cooldowns still
apply. See the main README's Instagram monitoring guidance. This isolation does
not require removing either watch, resetting schedules or migrating the database.

For a customized deployment, reconcile the running image, mounted source and
installed files before applying changes. Keep source/configuration backups and a
verified SQLite snapshot; preserve local integrations and settings. Do not commit
cookies, resolved configuration, database backups or private runtime diagnostics.
