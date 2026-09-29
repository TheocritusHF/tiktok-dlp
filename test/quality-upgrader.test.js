import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/state/store.js';
import { QualityUpgrader, hasHigherResolution, bestAdvertisedVideo } from '../src/quality/upgrader.js';

const HOUR = 60 * 60_000;
const ID = '1234567890123456789';
const URL = `https://www.tiktok.com/@example_creator/video/${ID}`;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-quality-worker-'));
  const downloadDir = path.join(root, 'downloads');
  const filepath = path.join(downloadDir, 'example_creator', `${ID}.mp4`);
  await mkdir(path.dirname(filepath), { recursive: true });
  await writeFile(filepath, 'old-576');
  const store = createStore(path.join(root, 'state.db'));
  const firstSavedAt = Date.now() - HOUR; // initial schedule six hours after download
  const fileId = store.createFileRecord({ sourceUrl: URL, filePath: filepath,
    filename: path.basename(filepath), sizeBytes: 7, username: 'example_creator', videoId: ID }, firstSavedAt);
  store.recordMediaDownload({ platform: 'tiktok', remoteId: ID, fileId,
    sourceUrl: URL, filePath: filepath, filename: path.basename(filepath),
    sizeBytes: 7, mediaType: 'video',
    assets: [{ path: filepath, kind: 'video', role: 'content', sizeBytes: 7, width: 576, height: 1024 }],
  }, firstSavedAt);
  return { root, downloadDir, filepath, store, firstSavedAt, fileId,
    async cleanup() { this.store.close(); await rm(root, { recursive: true, force: true }); } };
}

const logger = { info() {}, warn() {}, error() {} };
const inspect = async (filename) => {
  const bytes = await readFile(filename, 'utf8');
  if (bytes === 'old-576') return { width: 576, height: 1024, codec: 'h264' };
  if (bytes === 'new-720-long') return { width: 720, height: 1280, codec: 'hevc' };
  throw new Error(`Unexpected file content ${bytes}`);
};

test('resolution comparisons ignore orientation, require both dimensions to improve', () => {
  assert.equal(hasHigherResolution({ width: 720, height: 1280 }, { width: 576, height: 1024 }), true);
  assert.equal(hasHigherResolution({ width: 1280, height: 720 }, { width: 576, height: 1024 }), true);
  assert.equal(hasHigherResolution({ width: 576, height: 1024 }, { width: 576, height: 1024 }), false);
  assert.equal(hasHigherResolution({ width: 500, height: 2000 }, { width: 576, height: 1024 }), false);
  assert.deepEqual(bestAdvertisedVideo([{ height: 0, vcodec: 'none' }, { width: 576, height: 1024, vcodec: 'h264' },
    { width: 720, height: 1280, vcodec: 'hevc' }]), { width: 720, height: 1280, vcodec: 'hevc' });
});

test('6, 24 and 72 hour checks survive DB restart and finish after the final check', async () => {
  const f = await fixture();
  try {
    assert.equal(f.store.scheduleQualityUpgrade(f.fileId, f.firstSavedAt), true);
    f.store.createLinkToken({ token: 'existing-archive-link', fileId: f.fileId, expiresAt: 0, deliveryType: 'monitor' }, f.firstSavedAt);
    assert.equal(f.store.scheduleQualityUpgrade(f.fileId, f.firstSavedAt), false);
    let row = f.store.listQualityUpgradeRecords()[0];
    assert.equal(row.stage, 0);
    assert.equal(row.next_check_at, f.firstSavedAt + 6 * HOUR);
    const due6 = f.firstSavedAt + 6 * HOUR;
    const notifications = [];
    const worker = new QualityUpgrader({ store: f.store, config: { downloadDir: f.downloadDir },
      inspect, probeVideo: async () => ({ id: ID, formats: [{ width: 720, height: 1280, vcodec: 'hevc' }] }),
      downloadVideo: async (url, options) => {
        assert.equal(url, URL);
        assert.equal(options.format, 'bv*+ba/b');
        const candidate = path.join(options.outputDir, `${ID}.mp4`);
        await writeFile(candidate, 'new-720-long');
        return { primaryFile: candidate, videoId: ID };
      }, onUpgrade: async (upgrade) => {
        assert.equal(f.store.getLatestFileByPost('tiktok', ID).size_bytes, 12);
        notifications.push(upgrade);
      }, now: () => due6, logger,
    });
    await worker.runOnce();
    assert.equal(await readFile(f.filepath, 'utf8'), 'new-720-long');
    assert.equal((await stat(f.filepath)).size, f.store.getLatestFileByPost('tiktok', ID).size_bytes);
    assert.equal(f.store.getLatestFileByPost('tiktok', ID).id, f.fileId);
    assert.equal(f.store.db.prepare("SELECT file_id FROM link_tokens WHERE token = 'existing-archive-link'").get().file_id, f.fileId);
    assert.deepEqual(notifications.map((upgrade) => [upgrade.username, upgrade.previous.width, upgrade.current.width]),
      [['example_creator', 576, 720]]);
    assert.deepEqual(f.store.listMediaAssetsForFile(f.fileId)
      .filter((asset) => asset.path === f.filepath)
      .map((asset) => [asset.width, asset.height, asset.size_bytes]), [[720, 1280, 12]]);
    row = f.store.listQualityUpgradeRecords()[0];
    assert.equal(row.stage, 1);
    assert.equal(row.next_check_at, f.firstSavedAt + 24 * HOUR);
    assert.equal(row.completed_at, null);
    f.store.close();
    f.store = createStore(path.join(f.root, 'state.db'));
    assert.equal(f.store.getToken('existing-archive-link').id, f.fileId);
    // A second worker instance sees the persisted state after a database restart.
    const unexpectedNotifications = [];
    const worker24 = new QualityUpgrader({ store: f.store, config: { downloadDir: f.downloadDir },
      inspect, probeVideo: async () => ({ id: ID, formats: [{ width: 720, height: 1280, vcodec: 'hevc' }] }),
      downloadVideo: async () => { throw new Error('No higher format means no download.'); },
      onUpgrade: () => unexpectedNotifications.push('24h'),
      now: () => f.firstSavedAt + 24 * HOUR, logger,
    });
    await worker24.runOnce();
    row = f.store.listQualityUpgradeRecords()[0];
    assert.equal(row.stage, 2);
    assert.equal(row.next_check_at, f.firstSavedAt + 72 * HOUR);
    const worker72 = new QualityUpgrader({ store: f.store, config: { downloadDir: f.downloadDir },
      inspect, probeVideo: async () => ({ id: ID, formats: [{ width: 720, height: 1280, vcodec: 'hevc' }] }),
      downloadVideo: async () => { throw new Error('No download expected.'); },
      onUpgrade: () => unexpectedNotifications.push('72h'),
      now: () => f.firstSavedAt + 72 * HOUR, logger,
    });
    await worker72.runOnce();
    assert.deepEqual(unexpectedNotifications, []);
    row = f.store.listQualityUpgradeRecords()[0];
    assert.equal(row.completed_at, f.firstSavedAt + 72 * HOUR);
    assert.equal(row.next_check_at, null);
    assert.equal(f.store.listDueQualityUpgrades(f.firstSavedAt + 96 * HOUR).length, 0);
    assert.equal(f.store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { await f.cleanup(); }
});

test('failed upgrade notification cannot undo a committed improvement', async () => {
  const f = await fixture();
  try {
    f.store.scheduleQualityUpgrade(f.fileId, f.firstSavedAt);
    const warnings = [];
    const worker = new QualityUpgrader({ store: f.store, config: { downloadDir: f.downloadDir },
      inspect, probeVideo: async () => ({ id: ID, formats: [{ width: 720, height: 1280, vcodec: 'hevc' }] }),
      downloadVideo: async (_url, options) => {
        const candidate = path.join(options.outputDir, `${ID}.mp4`);
        await writeFile(candidate, 'new-720-long');
        return { primaryFile: candidate };
      }, onUpgrade: async () => { throw new Error('Discord unavailable'); },
      now: () => f.firstSavedAt + 6 * HOUR,
      logger: { info() {}, warn(message) { warnings.push(message); }, error() {} },
    });
    await worker.runOnce();
    assert.equal(await readFile(f.filepath, 'utf8'), 'new-720-long');
    assert.equal(f.store.listQualityUpgradeRecords()[0].stage, 1);
    assert.match(warnings.join('\n'), /Upgrade notification failed/);
  } finally { await f.cleanup(); }
});

test('unchanged quality never downloads; failures leave archive untouched and retry once', async () => {
  const f = await fixture();
  try {
    f.store.scheduleQualityUpgrade(f.fileId, f.firstSavedAt);
    const due = f.firstSavedAt + 6 * HOUR;
    let attempts = 0;
    const worker = new QualityUpgrader({ store: f.store, config: { downloadDir: f.downloadDir },
      inspect, probeVideo: async () => { attempts++; throw new Error('temporary 429'); },
      downloadVideo: async () => { throw new Error('Should not download.'); },
      now: () => due, logger });
    await worker.runOnce();
    assert.equal(attempts, 1);
    assert.equal(f.store.listQualityUpgradeRecords()[0].attempts, 1);
    assert.equal(f.store.listQualityUpgradeRecords()[0].next_check_at, due + HOUR);
    assert.equal(await readFile(f.filepath, 'utf8'), 'old-576');
  } finally { await f.cleanup(); }
});

test('stories and slideshows cannot be scheduled', async () => {
  const f = await fixture();
  try {
    const story = f.store.createFileRecord({ sourceUrl: 'https://www.tiktok.com/@creator/story/123456789',
      filePath: path.join(f.downloadDir, 'story.mp4'), filename: 'story.mp4', sizeBytes: 1, videoId: '123456789' }, Date.now());
    assert.equal(f.store.scheduleQualityUpgrade(story), false);
  } finally { await f.cleanup(); }
});

test('failed database commit rolls the archived bytes back and schedules a retry', async () => {
  const f = await fixture();
  try {
    f.store.scheduleQualityUpgrade(f.fileId, f.firstSavedAt);
    f.store.commitQualityUpgrade = () => { throw new Error('simulated database write failure'); };
    const due = f.firstSavedAt + 6 * HOUR;
    const notifications = [];
    const worker = new QualityUpgrader({ store: f.store, config: { downloadDir: f.downloadDir },
      inspect, probeVideo: async () => ({ id: ID, formats: [{ width: 720, height: 1280, vcodec: 'hevc' }] }),
      downloadVideo: async (url, options) => {
        const candidate = path.join(options.outputDir, `${ID}.mp4`);
        await writeFile(candidate, 'new-720-long');
        return { primaryFile: candidate };
      }, onUpgrade: () => notifications.push('unexpected'),
      now: () => due, logger });
    await worker.runOnce();
    assert.equal(await readFile(f.filepath, 'utf8'), 'old-576');
    assert.equal(f.store.getLatestFileByPost('tiktok', ID).size_bytes, 7);
    assert.deepEqual(notifications, []);
    assert.equal(f.store.listDueQualityUpgrades(due + HOUR).length, 1);
  } finally { await f.cleanup(); }
});

test('slideshow media type is never enrolled even if the URL contains /video/', async () => {
  const f = await fixture();
  try {
    f.store.recordMediaDownload({ platform: 'tiktok', remoteId: ID, fileId: f.fileId,
      sourceUrl: URL, filePath: f.filepath, filename: path.basename(f.filepath),
      sizeBytes: 7, mediaType: 'slideshow' }, f.firstSavedAt);
    assert.equal(f.store.scheduleQualityUpgrade(f.fileId, f.firstSavedAt), false);
  } finally { await f.cleanup(); }
});

test('shared active archive paths are refused for in-place upgrades', async () => {
  const f = await fixture();
  try {
    f.store.scheduleQualityUpgrade(f.fileId, f.firstSavedAt);
    f.store.createFileRecord({ platform: 'tiktok', videoId: '1234567890123456790',
      sourceUrl: URL, filePath: f.filepath, filename: path.basename(f.filepath),
      sizeBytes: 7 }, f.firstSavedAt);
    const worker = new QualityUpgrader({ store: f.store, config: { downloadDir: f.downloadDir },
      inspect, probeVideo: async () => { throw new Error('Shared path must be skipped'); },
      downloadVideo: async () => { throw new Error('Should not download'); },
      logger, now: () => f.firstSavedAt + 6 * HOUR });
    await worker.runOnce();
    assert.equal(await readFile(f.filepath, 'utf8'), 'old-576');
    assert.equal(f.store.listDueQualityUpgrades(f.firstSavedAt + 7 * HOUR).length, 0);
  } finally { await f.cleanup(); }
});


test('backfills recent monitored posts but excludes manual jobs and stories', async () => {
  const f = await fixture();
  try {
    const now = f.firstSavedAt + 2 * HOUR;
    assert.equal(f.store.backfillRecentQualityUpgrades(now), 0);
    const jobId = f.store.createJob({ type: 'monitor', sourceUrl: URL, videoId: ID }, f.firstSavedAt);
    f.store.updateJob(jobId, { status: 'complete', file_id: f.fileId }, now);
    assert.equal(f.store.backfillRecentQualityUpgrades(now), 1);
    assert.equal(f.store.backfillRecentQualityUpgrades(now), 0);
    assert.equal(f.store.listQualityUpgradeRecords()[0].next_check_at, f.firstSavedAt + 6 * HOUR);
  } finally { await f.cleanup(); }
});

test('failed DB commit rolls the original bytes back without changing file identity', async () => {
  const f = await fixture();
  try {
    const due = f.firstSavedAt + 6 * HOUR;
    f.store.scheduleQualityUpgrade(f.fileId, f.firstSavedAt);
    const realCommit = f.store.commitQualityUpgrade.bind(f.store);
    f.store.commitQualityUpgrade = () => { throw new Error('simulated SQLite write failure'); };
    const worker = new QualityUpgrader({ store: f.store, config: { downloadDir: f.downloadDir },
      inspect, probeVideo: async () => ({ id: ID, formats: [{ width: 720, height: 1280, vcodec: 'hevc' }] }),
      downloadVideo: async (url, options) => {
        const candidate = path.join(options.outputDir, `${ID}.mp4`);
        await writeFile(candidate, 'new-720-long');
        return { primaryFile: candidate, videoId: ID };
      }, now: () => due, logger });
    await worker.runOnce();
    f.store.commitQualityUpgrade = realCommit;
    assert.equal(await readFile(f.filepath, 'utf8'), 'old-576');
    assert.equal(f.store.getLatestFileByPost('tiktok', ID).size_bytes, 7);
    assert.equal(f.store.listQualityUpgradeRecords()[0].attempts, 1);
    assert.equal(f.store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { await f.cleanup(); }
});


test('schema 6 database migrates to version 7 while preserving old records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'quality-migration-'));
  const dbPath = path.join(root, 'state.db');
  let s = createStore(dbPath);
  try {
    const id = s.createFileRecord({ sourceUrl: URL, filePath: path.join(root, `${ID}.mp4`),
      filename: `${ID}.mp4`, sizeBytes: 123, videoId: ID }, Date.now());
    s.db.exec('DROP TABLE quality_upgrade_checks');
    s.db.prepare('DELETE FROM schema_migrations WHERE version=7').run();
    s.db.exec('PRAGMA user_version=6');
    s.close();
    s = createStore(dbPath);
    assert.equal(s.getSchemaVersion(), 7);
    assert.equal(s.getLatestFileByPost('tiktok', ID).id, id);
    assert.equal(s.scheduleQualityUpgrade(id), true);
    assert.equal(s.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    s.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an unresolved safety copy preserves the scheduled check and archived bytes', async () => {
  const f = await fixture();
  try {
    f.store.scheduleQualityUpgrade(f.fileId, f.firstSavedAt);
    await writeFile(f.filepath, 'uncommitted-different-size');
    await writeFile(`${f.filepath}.quality-backup`, 'unknown-backup');
    const worker = new QualityUpgrader({
      store: f.store, config: { downloadDir: f.downloadDir }, inspect,
      probeVideo: async () => { throw new Error('Probe must wait for recovery.'); },
      downloadVideo: async () => { throw new Error('Download must wait for recovery.'); },
      now: () => f.firstSavedAt + 6 * HOUR, logger,
    });
    await worker.runOnce();
    const row = f.store.listQualityUpgradeRecords()[0];
    assert.equal(row.stage, 0);
    assert.equal(row.attempts, 0);
    assert.equal(row.completed_at, null);
    assert.equal(await readFile(f.filepath, 'utf8'), 'uncommitted-different-size');
    assert.equal(await readFile(`${f.filepath}.quality-backup`, 'utf8'), 'unknown-backup');
  } finally { await f.cleanup(); }
});
