import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createStore } from '../src/state/store.js';
import { hashFile } from '../scripts/instagram-layout-migration.js';

async function fixture(t, count = 2) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ig-layout-cli-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'downloads'), backup = path.join(temp, 'backup'), database = path.join(temp, 'state.db');
  const store = createStore(database); const originals = [], ids = [];
  for (let i = 1; i <= count; i++) {
    const remoteId = `story_${i}`;
    const folder = path.join(root, 'instagram', 'fixture_creator', '2026', '10', '13', `${remoteId}-ABC`);
    await mkdir(folder, { recursive: true }); const filePath = path.join(folder, 'asset_001.mp4');
    await writeFile(filePath, 'original'); originals.push(filePath);
    const { fileId } = store.createFileWithMedia({
      file: { platform: 'instagram', videoId: remoteId, username: 'fixture_creator', filePath,
        sourceUrl: `https://www.instagram.com/stories/fixture_creator/${i}/`, filename: 'asset_001.mp4', sizeBytes: 8 },
      media: { platform: 'instagram', remoteId, creatorHandle: 'fixture_creator', mediaType: 'story', publishedAt: '2026-10-13T23:10:12Z',
        assets: [{ path: filePath, filename: 'asset_001.mp4', kind: 'video', width: 1080, height: 1920, sizeBytes: 8 }] },
    }); ids.push(fileId);
    store.setMediaFileBookmark(fileId, true);
    store.createLinkToken({ token: `private-fixture-token-${i}`, fileId, ownerId: 'fixture-owner', scopeId: 'channel:fixture', expiresAt: 0 });
  }
  store.close();
  const script = new URL('../scripts/migrate-instagram-archive.js', import.meta.url).pathname;
  function run(operation, extra = [], expectedExit = 0) {
    const result = spawnSync(process.execPath, [script, operation, '--database', database, '--downloads', root, ...extra], {
      encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1', DISCORD_TOKEN: 'private-fixture-discord-token' },
    });
    assert.equal(result.status, expectedExit, result.stdout + result.stderr);
    assert.equal((result.stdout + result.stderr).includes('private-fixture-token'), false);
    assert.equal((result.stdout + result.stderr).includes('private-fixture-discord-token'), false);
    return JSON.parse(result.stdout);
  }
  return { root, backup, database, originals, ids, run };
}
test('Read-only CLI plans the real store without modifying database or archive', async t => {
  const f = await fixture(t); const before = await hashFile(f.database);
  assert.equal(f.run('plan', ['--output', path.join(path.dirname(f.backup), 'plan.json')]).plan.recordsToMigrate, 2);
  assert.equal(await hashFile(f.database), before);
  for (const filename of f.originals) assert.equal((await readFile(filename)).toString(), 'original');
});
test('Real store migration keeps IDs, bookmarks, scoped link tokens and measured dimensions', async t => {
  const f = await fixture(t, 14); const result = f.run('apply', ['--backup', f.backup, '--offline']);
  assert.equal(result.records, 14); assert.equal(result.mismatches, 0);
  assert.equal(f.run('verify', ['--backup', f.backup]).status, 'INTEGRITY PASS');
  const store = createStore(f.database);
  assert.equal(store.listMediaAssetsForFile(f.ids[0])[0].width, 1080);
  assert.equal(store.getToken('private-fixture-token-1').id, f.ids[0]);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM bookmarks').get().count, 14);
  assert.equal(store.db.prepare('SELECT scope_id FROM link_tokens LIMIT 1').get().scope_id, 'channel:fixture'); store.close();
});
test('Targeted rollback retains later downloads and trash changes without replacing the database', async t => {
  const f = await fixture(t); f.run('apply', ['--backup', f.backup, '--offline']);
  const store = createStore(f.database); store.trashMediaFile(f.ids[0], 123);
  const later = path.join(f.root, 'later.mp4'); await writeFile(later, 'later');
  store.createFileRecord({ platform: 'tiktok', videoId: '333', username: 'later', filePath: later, sourceUrl: '', filename: 'later.mp4', sizeBytes: 5 }); store.close();
  assert.equal(f.run('rollback', ['--backup', f.backup, '--offline']).restoredPaths, 2);
  const check = new DatabaseSync(f.database); assert.equal(check.prepare('SELECT path FROM files WHERE platform=\'tiktok\'').get().path, later);
  assert.equal(check.prepare('SELECT trashed_at FROM files WHERE id=?').get(f.ids[0]).trashed_at, 123); check.close();
  for (const filename of f.originals) assert.equal((await readFile(filename)).toString(), 'original');
});
test('Rollback does not resurrect deleted records or their media', async t => {
  const f = await fixture(t); f.run('apply', ['--backup', f.backup, '--offline']);
  const db = new DatabaseSync(f.database); db.exec('PRAGMA foreign_keys=ON');
  db.prepare('DELETE FROM files WHERE id=?').run(f.ids[0]); db.close();
  assert.equal(f.run('rollback', ['--backup', f.backup, '--offline']).preservedDeletedRecords, 1);
  await assert.rejects(lstat(f.originals[0]), { code: 'ENOENT' });
});
test('Apply requires offline acknowledgement and backups outside the download tree', async t => {
  const f = await fixture(t);
  assert.match(f.run('apply', ['--backup', f.backup], 1).reason, /offline/);
  assert.match(f.run('apply', ['--backup', path.join(f.root, 'backup'), '--offline'], 1).reason, /separate/);
  await assert.rejects(lstat(f.backup), { code: 'ENOENT' });
});
test('Rollback validates all backup bytes before changing any database paths', async t => {
  const f = await fixture(t); f.run('apply', ['--backup', f.backup, '--offline']);
  const before = await hashFile(f.database);
  await writeFile(path.join(f.backup, 'migration', 'originals', '0_asset_001.mp4'), 'corrupt!');
  assert.match(f.run('rollback', ['--backup', f.backup, '--offline'], 1).reason, /hash verification/);
  assert.equal(await hashFile(f.database), before);
});
test('Planning rejects missing media and cannot overwrite an existing plan', async t => {
  const f = await fixture(t); await rm(f.originals[0]);
  const output = path.join(path.dirname(f.backup), 'plan.json');
  assert.equal(f.run('plan', ['--output', output], 2).status, 'BLOCKED');
  assert.equal(f.run('plan', ['--output', output], 1).status, 'ERROR');
});

test('A mistyped database path is never created by apply', async t => {
  const f = await fixture(t); const missing = path.join(path.dirname(f.backup), 'missing.db');
  assert.equal(f.run('apply', ['--database', missing, '--backup', f.backup, '--offline'], 1).status, 'ERROR');
  await assert.rejects(lstat(missing), { code: 'ENOENT' });
  await assert.rejects(lstat(f.backup), { code: 'ENOENT' });
});
test('Verification does not create a missing backup directory', async t => {
  const f = await fixture(t); assert.equal(f.run('verify', ['--backup', f.backup], 1).status, 'ERROR');
  await assert.rejects(lstat(f.backup), { code: 'ENOENT' });
});
test('Rollback refuses deletion claims and preserves the active migrated file', async t => {
  const f = await fixture(t); f.run('apply', ['--backup', f.backup, '--offline']);
  const db = new DatabaseSync(f.database);
  db.prepare(`UPDATE files SET retention_status='expiry_claimed' WHERE id=?`).run(f.ids[0]);
  const current = db.prepare('SELECT path FROM files WHERE id=?').get(f.ids[0]).path; db.close();
  assert.match(f.run('rollback', ['--backup', f.backup, '--offline'], 1).reason, /claimed/);
  assert.equal((await readFile(current)).toString(), 'original');
});
