import { DatabaseSync } from 'node:sqlite';
import { createReadStream, constants } from 'node:fs';
import { copyFile, lstat, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { instagramLayout, assertRegularFile, ensureDirectory, outside, assertExistingDirectory } from '../src/platforms/instagramLayout.js';

export async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
function readRows(db) {
  return db.prepare(`SELECT f.id, f.platform, f.video_id, f.username, f.path, f.filename,
    f.size_bytes, f.created_at, f.trashed_at, f.retention_status,
    p.id AS post_id, p.creator_handle, p.remote_id, p.media_type, p.published_at
    FROM files f LEFT JOIN media_posts p ON p.platform = f.platform AND p.remote_id = f.video_id
    WHERE f.platform = 'instagram' ORDER BY f.id`).all().map((file) => ({ ...file,
      assets: db.prepare(`SELECT id, post_id, file_id, role, position, kind, path, filename, size_bytes
        FROM media_assets WHERE file_id = ? ORDER BY position, id`).all(file.id) }));
}
function fingerprint(rows) { return createHash('sha256').update(JSON.stringify(rows)).digest('hex'); }
function resolveStored(root, stored) {
  const resolved = path.resolve(root, stored);
  if (outside(root, resolved)) throw new Error('Stored path is outside the archive.');
  return resolved;
}
async function exists(filename) {
  try { await lstat(filename); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

export async function createMigrationPlan({ databasePath, downloadDir }) {
  const root = path.resolve(downloadDir);
  await assertExistingDirectory(root);
  await assertRegularFile(path.dirname(path.resolve(databasePath)), path.resolve(databasePath));
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let rows;
  try { db.exec('BEGIN'); rows = readRows(db); db.exec('COMMIT'); } finally { db.close(); }
  const plan = { version: 1, layout: 'instagram-daily-v1', root, databasePath: path.resolve(databasePath),
    createdAt: new Date().toISOString(), fingerprint: fingerprint(rows), files: [], moves: [], blockers: [],
    summary: { instagramRecords: rows.length, recordsToMigrate: 0, alreadyOrganized: 0,
      stories: 0, posts: 0, highlights: 0, trashed: 0, copiedBytes: 0, blockers: 0 } };
  const seenSources = new Map();
  const destinations = new Set();
  for (const file of rows) {
    try {
      if (!['active', 'expiry_failed', 'trashed', 'trash_failed'].includes(file.retention_status)) throw new Error('Deletion is claimed or retention state is unsupported.');
      if (!file.post_id || !file.assets.length || file.assets.some(a => a.post_id !== file.post_id)) throw new Error('The media identity or recorded assets are incomplete.');
      const content = file.assets.filter(a => a.role !== 'package');
      if (!content.length) throw new Error('No recorded content assets.');
      const post = { platform: 'instagram', remoteId: file.remote_id,
        creator: { handle: file.creator_handle || file.username || 'unknown' }, mediaType: file.media_type,
        publishedAt: file.published_at == null ? file.created_at : file.published_at };
      let layout = instagramLayout(post, root, content);
      const sources = content.map(a => resolveStored(root, a.path));
      if (new Set(sources).size !== sources.length) throw new Error('Duplicate content paths need review.');
      const primarySource = resolveStored(root, file.path);
      const items = content.map((asset, i) => ({ source: sources[i], target: path.join(layout.directory, layout.filenames[i]),
        expectedBytes: asset.size_bytes, assetIds: [asset.id] }));
      const primaryIsContent = sources.includes(primarySource);
      if (!primaryIsContent) {
        if (!layout.bundlePath || path.extname(primarySource).toLowerCase() !== '.zip') throw new Error('The primary package is unsupported.');
        items.push({ source: primarySource, target: layout.bundlePath, expectedBytes: file.size_bytes,
          assetIds: file.assets.filter(a => resolveStored(root, a.path) === primarySource).map(a => a.id) });
      }
      if (file.assets.some(a => !items.some(item => item.source === resolveStored(root, a.path)))) throw new Error('An unrecognized auxiliary asset needs review.');
      if (items.every(item => item.source === item.target)) { plan.summary.alreadyOrganized++; continue; }
      // Separate repeated downloads of the same post; shared physical files keep a shared destination.
      if (items.some(item => !seenSources.has(item.source) && destinations.has(item.target.toLowerCase()))) {
        layout = instagramLayout(post, root, content, { suffix: `file_${file.id}` });
        items.forEach((item, i) => { item.target = i < content.length ? path.join(layout.directory, layout.filenames[i]) : layout.bundlePath; });
      }
      for (const item of items) {
        if (seenSources.has(item.source)) { item.target = seenSources.get(item.source).target; continue; }
        if (item.source !== item.target && await exists(item.target)) {
          layout = instagramLayout(post, root, content, { suffix: `file_${file.id}` });
          items.forEach((other, i) => { if (!seenSources.has(other.source)) other.target = i < content.length ? path.join(layout.directory, layout.filenames[i]) : layout.bundlePath; });
          break;
        }
      }
      if (items.every(item => item.source === item.target)) { plan.summary.alreadyOrganized++; continue; }
      const rowMoves = [];
      for (const item of items) {
        if (seenSources.has(item.source)) {
          const shared = seenSources.get(item.source);
          if (Number(item.expectedBytes) !== shared.bytes) throw new Error('Shared file sizes disagree.');
          item.target = shared.target; continue;
        }
        const info = await assertRegularFile(root, item.source);
        if (info.size !== Number(item.expectedBytes)) throw new Error('Disk size differs from the database.');
        if (item.source !== item.target && (destinations.has(item.target.toLowerCase()) || await exists(item.target))) throw new Error('A destination already exists; no file will be overwritten.');
        rowMoves.push({ source: item.source, target: item.target, bytes: info.size, sha256: await hashFile(item.source) });
      }
      const primary = items.find(item => item.source === primarySource);
      if (!primary) throw new Error('Primary file is not recorded among the assets.');
      // A primary asset must also match the file record, not only the media asset row.
      if ((await assertRegularFile(root, primarySource)).size !== Number(file.size_bytes)) throw new Error('Primary disk size differs from its file record.');
      plan.files.push({ id: file.id, oldPath: file.path, newPath: primary.target,
        oldFilename: file.filename, newFilename: path.basename(primary.target),
        assets: file.assets.map(asset => { const item = items.find(i => i.source === resolveStored(root, asset.path));
          return { id: asset.id, oldPath: asset.path, newPath: item.target, oldFilename: asset.filename, newFilename: path.basename(item.target) }; }) });
      for (const move of rowMoves) { seenSources.set(move.source, move); destinations.add(move.target.toLowerCase()); plan.moves.push(move); }
      plan.summary.recordsToMigrate++;
      const category = layout.directory.includes(`${path.sep}Stories${path.sep}`) ? 'stories'
        : layout.directory.includes(`${path.sep}Highlights${path.sep}`) ? 'highlights' : 'posts';
      plan.summary[category]++;
      if (file.trashed_at != null) plan.summary.trashed++;
    } catch (error) { plan.blockers.push({ fileId: file.id, reason: error.code === 'ENOENT' ? 'Recorded media is missing.'
      : ['EACCES', 'EPERM'].includes(error.code) ? 'Recorded media cannot be read.' : error.message }); }
  }
  // Do not move anything referenced by a non-Instagram record, even if paths coincide.
  const checkDb = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const outsidePaths = new Set(checkDb.prepare(`SELECT path FROM files WHERE platform <> 'instagram'
      UNION SELECT a.path FROM media_assets a JOIN files f ON f.id = a.file_id WHERE f.platform <> 'instagram'`).all().map(r => path.resolve(root, r.path)));
    for (const move of plan.moves) if (outsidePaths.has(move.source)) plan.blockers.push({ reason: 'A source path is also referenced by another platform.' });
  } finally { checkDb.close(); }
  plan.summary.copiedBytes = plan.moves.reduce((sum, m) => sum + (m.source !== m.target ? m.bytes : 0), 0);
  plan.summary.blockers = plan.blockers.length;
  return plan;
}

// Offline-only implementation. The installer must stop every archive writer and back up the database first.
export async function applyMigrationPlan(plan, { backupDir, offline = false } = {}) {
  if (!offline || plan.version !== 1 || plan.layout !== 'instagram-daily-v1' || plan.blockers.length) throw new Error('Migration requires an offline, unblocked reviewed plan.');
  const backup = path.resolve(backupDir);
  if (!outside(plan.root, backup)) throw new Error('Migration originals must be backed up outside the download directory.');
  if (await exists(backup)) throw new Error('Use a fresh migration backup directory.');
  await ensureDirectory(path.dirname(backup), backup);
  const journalFile = path.join(backup, 'migration-journal.json');
  const journal = { version: 1, state: 'copying', plan, originals: [] };
  await writeFile(journalFile, JSON.stringify(journal, null, 2), { flag: 'wx' });
  const created = [];
  const db = new DatabaseSync(plan.databasePath);
  let committed = false;
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    if (fingerprint(readRows(db)) !== plan.fingerprint) throw new Error('Instagram database records changed since the plan.');
    const otherPaths = new Set(db.prepare(`SELECT path FROM files WHERE platform <> 'instagram'
      UNION SELECT a.path FROM media_assets a JOIN files f ON f.id=a.file_id WHERE f.platform <> 'instagram'`).all().map(r => path.resolve(plan.root, r.path)));
    if (plan.moves.some(move => otherPaths.has(move.source))) throw new Error('A migration path is shared with another platform.');
    for (const move of plan.moves) {
      if ((await assertRegularFile(plan.root, move.source)).size !== move.bytes || await hashFile(move.source) !== move.sha256) throw new Error('A source file changed since planning.');
      if (move.source === move.target) continue;
      await ensureDirectory(plan.root, path.dirname(move.target));
      await copyFile(move.source, move.target, constants.COPYFILE_EXCL); created.push(move.target);
      if (await hashFile(move.target) !== move.sha256) throw new Error('Copied media hash differs.');
    }
    // Preserve identities, sizes, quality, timestamps, bookmarks, tokens and retention/trash state.
    for (const file of plan.files) {
      const change = db.prepare('UPDATE files SET path=?, filename=? WHERE id=? AND path=? AND platform=\'instagram\'')
        .run(file.newPath, file.newFilename, file.id, file.oldPath);
      if (change.changes !== 1) throw new Error('File path update did not match exactly one record.');
      for (const asset of file.assets) {
        const changed = db.prepare('UPDATE media_assets SET path=?, filename=? WHERE id=? AND file_id=? AND path=?')
          .run(asset.newPath, asset.newFilename, asset.id, file.id, asset.oldPath);
        if (changed.changes !== 1) throw new Error('Asset path update did not match exactly one record.');
      }
    }
    journal.state = 'ready-to-commit'; await writeFile(journalFile, JSON.stringify(journal, null, 2));
    db.exec('COMMIT'); committed = true;
    journal.state = 'committed'; await writeFile(journalFile, JSON.stringify(journal, null, 2));
    // Move originals out of daily browsing only after verified copies and the database commit.
    for (const [index, move] of plan.moves.entries()) {
      if (move.source === move.target) continue;
      const target = path.join(backup, 'originals', `${index}_${path.basename(move.source)}`);
      await ensureDirectory(backup, path.dirname(target));
      journal.originals.push({ source: move.source, backup: target });
      await writeFile(journalFile, JSON.stringify(journal, null, 2));
      await rename(move.source, target);
      await pruneEmpty(path.dirname(move.source), plan.root);
    }
    journal.state = 'complete'; await writeFile(journalFile, JSON.stringify(journal, null, 2));
    return { migratedRecords: plan.files.length, verifiedMediaFiles: created.length, backupDir: backup };
  } catch (error) {
    if (!committed) {
      try { db.exec('ROLLBACK'); } catch {}
      for (const file of created) await rm(file, { force: true });
      journal.state = 'failed-before-commit'; await writeFile(journalFile, JSON.stringify(journal, null, 2));
    }
    // After a commit, copies and originals are deliberately retained for explicit recovery.
    throw error;
  } finally { db.close(); }
}
async function pruneEmpty(directory, root) {
  let current = directory;
  while (outside(root, current) === false) {
    try { await rmdir(current); } catch { return; }
    current = path.dirname(current);
  }
}
