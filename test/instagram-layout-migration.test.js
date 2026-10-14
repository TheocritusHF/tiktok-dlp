import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { instagramLayout } from '../src/platforms/instagramLayout.js';
import { createMigrationPlan, applyMigrationPlan, hashFile } from '../scripts/instagram-layout-migration.js';
const post = { platform: 'instagram', remoteId: 'story_1234567890123456789', creator: { handle: 'fixture_creator' }, mediaType: 'story', publishedAt: '2026-10-13T23:10:12Z' };
async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ig-migration-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  return { temp, root: path.join(temp, 'downloads') };
}
async function databaseFixture(t) {
  const f = await fixture(t); const databasePath = path.join(f.temp, 'state.db');
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE files (id INTEGER PRIMARY KEY, platform TEXT, video_id TEXT, username TEXT, path TEXT, filename TEXT,
    size_bytes INTEGER, created_at INTEGER, trashed_at INTEGER, retention_status TEXT);
    CREATE TABLE media_posts (id INTEGER PRIMARY KEY, platform TEXT, remote_id TEXT, creator_handle TEXT, media_type TEXT, published_at INTEGER);
    CREATE TABLE media_assets (id INTEGER PRIMARY KEY, post_id INTEGER, file_id INTEGER, role TEXT, position INTEGER, kind TEXT, path TEXT, filename TEXT, size_bytes INTEGER, width INTEGER, height INTEGER);
    CREATE TABLE bookmarks (id INTEGER PRIMARY KEY, post_id INTEGER);
    CREATE TABLE link_tokens (token TEXT, file_id INTEGER);`);
  const legacy = path.join(f.root, 'instagram', 'fixture_creator', '2026', '10', '13', 'story_1234567890123456789-ABC');
  await mkdir(legacy, { recursive: true }); const oldFile = path.join(legacy, 'asset_001.mp4'); await writeFile(oldFile, 'original');
  db.prepare(`INSERT INTO files VALUES (1,'instagram',?,'fixture_creator',?,'asset_001.mp4',8,?,NULL,'active')`).run(post.remoteId, oldFile, Date.parse(post.publishedAt));
  db.prepare(`INSERT INTO media_posts VALUES (1,'instagram',?,'fixture_creator','story',?)`).run(post.remoteId, Date.parse(post.publishedAt));
  db.prepare(`INSERT INTO media_assets VALUES (1,1,1,'content',1,'video',?,'asset_001.mp4',8,1080,1920)`).run(oldFile);
  db.exec(`INSERT INTO bookmarks VALUES (1,1); INSERT INTO link_tokens VALUES ('unchanged-token',1);`);
  db.close(); return { ...f, databasePath, oldFile };
}
test('Read-only migration planning does not change database or media bytes', async t => {
  const f = await databaseFixture(t); const before = await hashFile(f.databasePath);
  const plan = await createMigrationPlan({ databasePath: f.databasePath, downloadDir: f.root });
  assert.equal(plan.summary.blockers, 0); assert.equal(plan.summary.recordsToMigrate, 1);
  assert.equal(await hashFile(f.databasePath), before); assert.equal((await readFile(f.oldFile)).toString(), 'original');
});
test('Offline migration updates both paths, keeps IDs/links/bookmarks/quality, and saves originals', async t => {
  const f = await databaseFixture(t); const plan = await createMigrationPlan({ databasePath: f.databasePath, downloadDir: f.root });
  const backupDir = path.join(f.temp, 'backup'); await applyMigrationPlan(plan, { backupDir, offline: true });
  const db = new DatabaseSync(f.databasePath); const file = db.prepare('SELECT * FROM files WHERE id=1').get(); const asset = db.prepare('SELECT * FROM media_assets WHERE id=1').get();
  assert.equal(file.path, asset.path); assert.equal(file.filename, asset.filename); assert.match(file.path, /\/Stories\/2026\/10\/13\//);
  assert.equal(asset.width, 1080); assert.equal(asset.height, 1920); assert.equal(file.retention_status, 'active');
  assert.equal(db.prepare('SELECT token FROM link_tokens').get().token, 'unchanged-token'); assert.equal(db.prepare('SELECT post_id FROM bookmarks').get().post_id, 1); db.close();
  assert.equal((await readFile(file.path)).toString(), 'original'); await assert.rejects(lstat(f.oldFile), { code: 'ENOENT' });
  assert.equal((await readFile(path.join(backupDir, 'originals', '0_asset_001.mp4'))).toString(), 'original');
  const again = await createMigrationPlan({ databasePath: f.databasePath, downloadDir: f.root }); assert.equal(again.summary.alreadyOrganized, 1); assert.equal(again.summary.recordsToMigrate, 0);
});
test('Trash stays trashed and non-Instagram database records stay unchanged', async t => {
  const f = await databaseFixture(t); const db = new DatabaseSync(f.databasePath);
  db.exec(`UPDATE files SET retention_status='trashed', trashed_at=123 WHERE id=1; INSERT INTO files VALUES (2,'tiktok','987','someone','/elsewhere/video.mp4','video.mp4',20,1,NULL,'active')`); db.close();
  // Cross-platform archive files may live outside the configured root; do not inspect or move them.
  const plan = await createMigrationPlan({ databasePath: f.databasePath, downloadDir: f.root });
  assert.equal(plan.summary.trashed, 1); await applyMigrationPlan(plan, { backupDir: path.join(f.temp, 'backup'), offline: true });
  const check = new DatabaseSync(f.databasePath); assert.equal(check.prepare('SELECT trashed_at FROM files WHERE id=1').get().trashed_at, 123);
  assert.equal(check.prepare('SELECT path FROM files WHERE id=2').get().path, '/elsewhere/video.mp4'); check.close();
});
test('Mismatch or missing media blocks a migration', async t => {
  const f = await databaseFixture(t); await writeFile(f.oldFile, 'changed');
  const plan = await createMigrationPlan({ databasePath: f.databasePath, downloadDir: f.root }); assert.equal(plan.summary.blockers, 1);
  await assert.rejects(applyMigrationPlan(plan, { backupDir: path.join(f.temp, 'backup'), offline: true }));
});
test('A changed plan cannot update the database or remove original files', async t => {
  const f = await databaseFixture(t); const plan = await createMigrationPlan({ databasePath: f.databasePath, downloadDir: f.root });
  await writeFile(f.oldFile, 'modified');
  await assert.rejects(applyMigrationPlan(plan, { backupDir: path.join(f.temp, 'backup'), offline: true }));
  const check = new DatabaseSync(f.databasePath); assert.equal(check.prepare('SELECT path FROM files').get().path, f.oldFile); check.close();
});
test('Destination collision produces a deterministic file-ID suffix without overwriting', async t => {
  const f = await databaseFixture(t); const layout = instagramLayout(post, f.root, [{ filename: 'asset_001.mp4' }]);
  await mkdir(layout.directory, { recursive: true }); const occupied = path.join(layout.directory, layout.filenames[0]); await writeFile(occupied, 'keep');
  const plan = await createMigrationPlan({ databasePath: f.databasePath, downloadDir: f.root }); assert.equal(plan.summary.blockers, 0);
  assert.match(plan.files[0].newFilename, /__file_1.mp4$/); await applyMigrationPlan(plan, { backupDir: path.join(f.temp, 'backup'), offline: true });
  assert.equal((await readFile(occupied)).toString(), 'keep');
});
test('Database deletion claims block planning', async t => {
  const f = await databaseFixture(t); const db = new DatabaseSync(f.databasePath); db.exec(`UPDATE files SET retention_status='expiry_claimed'`); db.close();
  const plan = await createMigrationPlan({ databasePath: f.databasePath, downloadDir: f.root }); assert.equal(plan.summary.blockers, 1);
});


test('Multi-asset migration retains the existing ZIP bytes and updates its recorded package path', async t => {
  const f = await databaseFixture(t); const oldPackage = path.join(path.dirname(f.oldFile), 'old.zip'); await writeFile(oldPackage, 'preserved zip');
  const second = path.join(path.dirname(f.oldFile), 'asset_002.jpg'); await writeFile(second, 'image');
  const db = new DatabaseSync(f.databasePath);
  db.prepare(`UPDATE files SET path=?,filename='old.zip',size_bytes=13`).run(oldPackage);
  db.prepare(`INSERT INTO media_assets VALUES(2,1,1,'content',2,'image',?,'asset_002.jpg',5,1080,1920)`).run(second);
  db.prepare(`INSERT INTO media_assets VALUES(3,1,1,'package',0,'archive',?,'old.zip',13,NULL,NULL)`).run(oldPackage); db.close();
  const plan = await createMigrationPlan({ databasePath: f.databasePath, downloadDir: f.root }); assert.equal(plan.summary.blockers, 0);
  await applyMigrationPlan(plan, { backupDir: path.join(f.temp, 'backup'), offline: true });
  const check = new DatabaseSync(f.databasePath); const primary = check.prepare('SELECT path FROM files').get().path;
  assert.match(primary, /\/_bundles\/.+\.zip$/); assert.equal((await readFile(primary)).toString(), 'preserved zip');
  assert.equal(check.prepare('SELECT path FROM media_assets WHERE id=3').get().path, primary); check.close();
});
test('Changed database state blocks stale plans before creating media copies', async t => {
  const f = await databaseFixture(t); const plan = await createMigrationPlan({ databasePath: f.databasePath, downloadDir: f.root });
  const db = new DatabaseSync(f.databasePath); db.exec(`UPDATE files SET retention_status='trashed',trashed_at=123`); db.close();
  await assert.rejects(applyMigrationPlan(plan, { backupDir: path.join(f.temp, 'backup'), offline: true }), /records changed/);
  assert.equal((await readFile(f.oldFile)).toString(), 'original');
  await assert.rejects(lstat(plan.files[0].newPath), { code: 'ENOENT' });
});
