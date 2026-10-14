# Migrating an existing Instagram archive

New downloads use daily folders when `INSTAGRAM_ARCHIVE_LAYOUT=daily` (the default).
Older archives remain usable in Rewind and through their existing links. Migration is
optional; startup never moves old media. Choose `legacy` to keep per-item folders for
future downloads. Changing that setting does not reverse an existing migration.

## Read-only review

Use Node 22.12+ with this repository's installed dependencies. Run where stored paths
resolve to the same files, normally inside the bot's Docker image and data mount.
Do not substitute Windows host paths for Linux paths recorded by a Docker bot.

```sh
node scripts/migrate-instagram-archive.js plan \
  --database /app/data/state.db --downloads /app/data/downloads \
  --output /app/data/instagram-layout-plan.json
```

The planner reads the database, verifies recorded sizes and hashes, and writes a plan
without changing media or database records. The output path must not already exist.
Review the JSON locally; it contains creator filenames and paths. Missing media,
unsupported records, deletion claims, inconsistent sizes, symlinks, unsafe paths and
unresolvable collisions block migration. Other platforms' records are excluded.

## Apply offline

Wait for downloads, imports and LIVE recordings to finish, then stop every process
that writes this archive or database. The `--offline` flag acknowledges that you have
stopped them; it cannot stop another Docker service or an external writer for you.
Keep them stopped until migration and verification finish. Choose a private, fresh
backup directory outside the downloads tree; a non-empty directory is rejected.

```sh
node scripts/migrate-instagram-archive.js apply \
  --database /app/data/state.db --downloads /app/data/downloads \
  --backup /app/data/instagram-layout-backup --offline
node scripts/migrate-instagram-archive.js verify \
  --database /app/data/state.db --downloads /app/data/downloads \
  --backup /app/data/instagram-layout-backup
```

Apply takes a fresh stopped-state plan, checkpoints SQLite, verifies a database backup,
checks free space, copies and hashes media, and updates `files.path/filename` and
`media_assets.path/filename` in one transaction. IDs, tokens, bookmarks, resolution,
timestamps and trash/retention state stay unchanged. The tool checks every database
table for unexpected changes before reporting success. Originals are moved to backup
only after verified copies and the database commit. Empty old folders are pruned;
unrecorded files are left untouched. Existing ZIP contents are preserved byte-for-byte.

With Docker Compose, stop the downloader service first, then use
`docker compose run --rm --no-deps --entrypoint node tiktok-discord-downloader`
before the script path/arguments above. This starts only the migration command, not
the bot. The ordinary data bind mount must remain writable for apply/rollback.
After verification, restart the downloader and check a migrated Story in Rewind.
Do not restart it after an unresolved migration error; retain backups and inspect the
reported state first. The CLI tries targeted path recovery if application fails.

## Rollback paths

Stop archive writers again. Reuse the migration's backup directory:

```sh
node scripts/migrate-instagram-archive.js rollback \
  --database /app/data/state.db --downloads /app/data/downloads \
  --backup /app/data/instagram-layout-backup --offline
```

Rollback verifies original bytes before restoring old paths. It does not replace the
live database, so later downloads, watch changes, link deliveries and trash changes
are retained. Deleted records are not resurrected. Changed or still-referenced media
copies are retained rather than overwritten or deleted. A claimed deletion or an
unrecognized path change requires review before rollback. Rollback does not uninstall
code or change the future-download layout setting.

## Privacy and retention

Backups include a complete database and original media, so they can contain private
archives and bearer download-link tokens. Keep them in a private directory outside
HTTP-served downloads; use host filesystem ACLs where appropriate. Created plan and
snapshot files, and the database backup, use restrictive file modes on platforms that
support them. CLI output contains summaries rather than tokens, captions or signed
media URLs. Never upload a plan, database or media backup in a public PR or issue.

The backup is for rollback on this disk; it is not an independent disaster-recovery
copy. Normal archive retention does not purge these backups. Decide separately when
rollback is no longer needed and remove them locally; deleted media may still exist
in retained backups. Default artifact names and database files are gitignored, but
custom names still require review before committing.
