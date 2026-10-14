import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFile, writeFile, copyFile, lstat, rm, statfs, mkdir, readdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { constants } from 'node:fs';
import { createMigrationPlan, applyMigrationPlan, hashFile } from './instagram-layout-migration.js';
import { assertRegularFile, ensureDirectory, outside, assertExistingDirectory } from '../src/platforms/instagramLayout.js';

let operation, databasePath, downloadDir, backupDir, planPath, snapshotPath, backupDatabasePath;
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function rowsDigest(rows) { return digest(rows.map(r => JSON.stringify(r)).sort()); }
function invariants(db) {
  const tables = db.prepare(`SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name`).all();
  const result = {};
  for (const { name } of tables) {
    const quoted = '"' + name.replaceAll('"', '""') + '"';
    const rows = db.prepare(`SELECT * FROM ${quoted}`).all();
    result[name] = { count: rows.length, sha256: rowsDigest(rows.map(row => {
      if (name !== 'files' && name !== 'media_assets') return row;
      const { path: ignoredPath, filename: ignoredFilename, ...unchanged } = row;
      return unchanged;
    })) };
  }
  result.schema = digest(db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name`).all());
  result.otherPlatformPaths = rowsDigest(db.prepare(`SELECT id,platform,path,filename FROM files WHERE platform <> 'instagram' ORDER BY id`).all());
  result.otherPlatformAssetPaths = rowsDigest(db.prepare(`SELECT a.id,a.path,a.filename FROM media_assets a JOIN files f ON a.file_id=f.id WHERE f.platform <> 'instagram' ORDER BY a.id`).all());
  return result;
}
function integrity(db) {
  const check = db.prepare('PRAGMA quick_check').all();
  if (check.length !== 1 || Object.values(check[0])[0] !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database integrity check failed.');
}
async function exists(filename) {
  try { await lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function readPlan() {
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  if (plan.version !== 1 || plan.layout !== 'instagram-daily-v1' || plan.root !== path.resolve(downloadDir)
    || plan.databasePath !== path.resolve(databasePath) || plan.blockers.length) throw new Error('Unexpected stopped migration plan.');
  return plan;
}
function originalBackup(plan, index) {
  return path.join(backupDir, 'migration', 'originals', `${index}_${path.basename(plan.moves[index].source)}`);
}
async function verifyHash(filename, expected, root) {
  await assertRegularFile(root, filename);
  if (await hashFile(filename) !== expected) throw new Error('Media hash verification failed.');
}
async function verifyMigrated(plan, { exactSnapshot = false, checkOriginals = true } = {}) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    integrity(db);
    if (exactSnapshot) {
      const before = JSON.parse(await readFile(snapshotPath, 'utf8'));
      if (JSON.stringify(before) !== JSON.stringify(invariants(db))) throw new Error('Database values beyond the planned names/paths changed.');
    }
    for (const file of plan.files) {
      const row = db.prepare('SELECT path,filename FROM files WHERE id=? AND platform=\'instagram\'').get(file.id);
      if (!row || row.path !== file.newPath || row.filename !== file.newFilename) throw new Error('Migrated file record differs.');
      for (const asset of file.assets) {
        const saved = db.prepare('SELECT path,filename FROM media_assets WHERE id=? AND file_id=?').get(asset.id, file.id);
        if (!saved || saved.path !== asset.newPath || saved.filename !== asset.newFilename) throw new Error('Migrated asset record differs.');
      }
    }
    for (const [index, move] of plan.moves.entries()) {
      await verifyHash(move.target, move.sha256, downloadDir);
      if (checkOriginals && move.source !== move.target) await verifyHash(originalBackup(plan, index), move.sha256, backupDir);
    }
    return { records: plan.files.length, verifiedMediaFiles: plan.moves.length, mismatches: 0 };
  } finally { db.close(); }
}
async function recoverPaths(plan) {
  // Targeted path rollback retains new downloads and changes to watch, quality, trash and delivery state.
  const db = new DatabaseSync(databasePath);
  const restored = [], retainedDeleted = [];
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    integrity(db);
    const activeSources = new Set();
    for (const file of plan.files) {
      const row = db.prepare('SELECT * FROM files WHERE id=?').get(file.id);
      if (!row) { retainedDeleted.push(file.id); continue; }
      if (row.platform !== 'instagram' || ![file.oldPath, file.newPath].includes(row.path)) throw new Error('A migrated file record changed outside this installation.');
      if (['expiry_claimed', 'trash_claimed'].includes(row.retention_status)) throw new Error('A migrated item is claimed for deletion; retry rollback after cleanup finishes.');
      for (const asset of file.assets) {
        const current = db.prepare('SELECT * FROM media_assets WHERE id=? AND file_id=?').get(asset.id, file.id);
        if (!current || ![asset.oldPath, asset.newPath].includes(current.path)) throw new Error('A migrated asset changed outside this installation.');
        activeSources.add(path.resolve(downloadDir, asset.oldPath));
      }
      activeSources.add(path.resolve(downloadDir, file.oldPath));
    }
    // Validate all originals before copying any; a committed migration may have moved only a subset.
    for (const [index, move] of plan.moves.entries()) {
      if (!activeSources.has(move.source)) continue;
      if (await exists(move.source)) await verifyHash(move.source, move.sha256, downloadDir);
      else await verifyHash(originalBackup(plan, index), move.sha256, backupDir);
    }
    for (const [index, move] of plan.moves.entries()) {
      if (!activeSources.has(move.source) || await exists(move.source)) continue;
      await ensureDirectory(downloadDir, path.dirname(move.source));
      await copyFile(originalBackup(plan, index), move.source, constants.COPYFILE_EXCL); restored.push(move.source);
      await verifyHash(move.source, move.sha256, downloadDir);
    }
    for (const file of plan.files) {
      if (retainedDeleted.includes(file.id)) continue;
      db.prepare('UPDATE files SET path=?,filename=? WHERE id=?').run(file.oldPath, file.oldFilename, file.id);
      for (const asset of file.assets) db.prepare('UPDATE media_assets SET path=?,filename=? WHERE id=? AND file_id=?')
        .run(asset.oldPath, asset.oldFilename, asset.id, file.id);
    }
    integrity(db); db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    for (const filename of restored) await rm(filename, { force: true });
    throw error;
  } finally { db.close(); }
  // Remove migrated copies only when no file or media-asset record still references them.
  const check = new DatabaseSync(databasePath, { readOnly: true });
  let removed = 0, kept = 0;
  try {
    const references = new Set(check.prepare('SELECT path FROM files UNION SELECT path FROM media_assets').all().map(r => path.resolve(downloadDir, r.path)));
    for (const move of plan.moves) {
      if (move.source === move.target || references.has(move.target) || !await exists(move.target)) { kept++; continue; }
      try { await verifyHash(move.target, move.sha256, downloadDir); }
      catch { kept++; continue; } // Preserve any changed/unrecognized copy for review rather than delete it.
      await rm(move.target); removed++;
    }
  } finally { check.close(); }
  return { restoredPaths: restored.length, removedCopies: removed, preservedDeletedRecords: retainedDeleted.length, keptCopies: kept };
}
async function main() {
  const args = parseArgs({ options: {
    database: { type: 'string' }, downloads: { type: 'string' },
    backup: { type: 'string' }, output: { type: 'string' }, offline: { type: 'boolean', default: false },
  }, allowPositionals: true });
  if (args.positionals.length !== 1 || !['plan', 'apply', 'verify', 'rollback'].includes(args.positionals[0])) {
    throw new Error('Usage: node scripts/migrate-instagram-archive.js plan|apply|verify|rollback [--database PATH] [--downloads PATH] [--output PLAN] [--backup DIR] [--offline]');
  }
  operation = args.positionals[0];
  const config = loadConfig();
  databasePath = path.resolve(args.values.database || config.stateDbPath);
  downloadDir = path.resolve(args.values.downloads || config.downloadDir);
  await assertRegularFile(path.dirname(databasePath), databasePath);
  await assertExistingDirectory(downloadDir);
  if (operation === 'plan') {
    if (!args.values.output) throw new Error('Read-only planning requires --output PATH.');
    const plan = await createMigrationPlan({ databasePath, downloadDir });
    await writeFile(path.resolve(args.values.output), JSON.stringify(plan, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ status: plan.blockers.length ? 'BLOCKED' : 'PLAN PASS', plan: plan.summary,
      blockers: plan.blockers.map(({ fileId, reason }) => ({ fileId, reason })) }));
    if (plan.blockers.length) process.exitCode = 2;
    return;
  }
  if (!args.values.backup) throw new Error('This operation requires --backup DIR.');
  backupDir = path.resolve(args.values.backup);
  if (!outside(downloadDir, backupDir) || !outside(backupDir, downloadDir)) throw new Error('Backup and downloads directories must be separate.');
  planPath = path.join(backupDir, 'stopped-plan.json');
  snapshotPath = path.join(backupDir, 'before-state.json');
  backupDatabasePath = path.join(backupDir, 'state-before.db');
  if (['apply', 'rollback'].includes(operation) && !args.values.offline) throw new Error('Stop every archive writer and pass --offline before modifying archive paths.');
  if (operation === 'apply') {
    if (await exists(backupDir)) {
      await ensureDirectory(path.dirname(backupDir), backupDir);
      if ((await readdir(backupDir)).length) throw new Error('Apply requires a fresh empty backup directory.');
    } else {
      await ensureDirectory(path.dirname(backupDir), path.dirname(backupDir));
      await mkdir(backupDir, { mode: 0o700 });
    }
  } else {
    await assertExistingDirectory(backupDir);
  }
  if (operation === 'apply') {
    const db = new DatabaseSync(databasePath);
    try {
      db.exec('PRAGMA busy_timeout=5000');
      const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (Number(checkpoint.busy) !== 0) throw new Error('Database checkpoint is busy; another writer or reader needs review.');
      integrity(db);
      await writeFile(snapshotPath, JSON.stringify(invariants(db), null, 2), { flag: 'wx', mode: 0o600 });
    } finally { db.close(); }
    await copyFile(databasePath, backupDatabasePath, constants.COPYFILE_EXCL);
    if (await hashFile(databasePath) !== await hashFile(backupDatabasePath)) throw new Error('Stopped database backup hash differs.');
    await chmod(backupDatabasePath, 0o600);
    const backup = new DatabaseSync(backupDatabasePath, { readOnly: true }); try { integrity(backup); } finally { backup.close(); }
    const plan = await createMigrationPlan({ databasePath, downloadDir });
    await writeFile(planPath, JSON.stringify(plan, null, 2), { flag: 'wx', mode: 0o600 });
    if (plan.blockers.length) throw new Error('Stopped archive planning found blockers; no migration was performed.');
    const space = await statfs(downloadDir);
    if (Number(space.bavail) * Number(space.bsize) < plan.summary.copiedBytes + 64 * 1024 * 1024) throw new Error('Insufficient free space for verified media copies and database updates.');
    const savedPlan = await readPlan();
    try {
      await applyMigrationPlan(savedPlan, { backupDir: path.join(backupDir, 'migration'), offline: true });
      console.log(JSON.stringify({ status: 'MIGRATION PASS', ...await verifyMigrated(savedPlan, { exactSnapshot: true }) }));
    } catch (error) {
      try { await recoverPaths(savedPlan); }
      catch { throw new Error('Migration recovery requires review; retain the database/media backups and keep writers stopped.'); }
      throw new Error('Migration failed; original database paths were recovered. Backups retained.');
    }
  } else if (operation === 'rollback') {
    console.log(JSON.stringify({ status: 'PATH ROLLBACK PASS', ...await recoverPaths(await readPlan()) }));
  } else {
    console.log(JSON.stringify({ status: 'INTEGRITY PASS', ...await verifyMigrated(await readPlan(), { exactSnapshot: false }) }));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.log(JSON.stringify({ status: 'ERROR', reason: (error.code === 'ENOENT' ? 'A required file or directory is missing.' : error.code === 'EEXIST' ? 'A destination file already exists.' : ['EACCES', 'EPERM'].includes(error.code) ? 'Filesystem access is denied.' : String(error.message)).replace(/https?:\/\/\S+/g, '[URL]') })); process.exitCode = 1; });
