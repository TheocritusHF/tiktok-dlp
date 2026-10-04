import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore, Store } from '../src/state/store.js';

test('watch reads preserve platform isolation and prefer guild subscriptions over legacy channels', () => {
  const store = new Store(':memory:');
  try {
    for (const platform of ['tiktok', 'instagram']) {
      store.addWatch('creator', { platform, channelId: 'legacy-channel' }, 1000);
      store.addWatch('creator', { platform, guildId: 'guild-1', channelId: `${platform}-channel` }, 2000);
      store.addWatch('creator', { platform, guildId: 'guild-2', channelId: 'other-channel' }, 3000);
    }
    assert.equal(store.getWatch('creator').platform, 'tiktok');
    assert.equal(store.getWatch('creator', { platform: 'instagram' }).platform, 'instagram');
    assert.equal(store.getWatch('creator', 'x'), null);
    assert.deepEqual(store.listWatches('instagram'), store.listWatches({ platform: 'instagram' }));
    assert.deepEqual(store.listWatches().map((watch) => watch.platform), ['instagram', 'tiktok']);

    const scope = { guildId: 'guild-1', channelId: 'legacy-channel' };
    assert.deepEqual(store.listWatchesForScope(scope).map((watch) => watch.subscription_channel_id), ['instagram-channel', 'tiktok-channel']);
    const instagram = store.listWatchesForScope({ ...scope, platform: 'instagram' });
    assert.equal(instagram.length, 1);
    assert.equal(instagram[0].subscription_channel_id, 'instagram-channel');
    assert.deepEqual(store.listWatchesForScope({ ...scope, platform: 'x' }), []);
    assert.equal(store.getWatchSubscription('creator', { guildId: 'guild-1', platform: 'instagram' }).channel_id, 'instagram-channel');
    assert.equal(store.getWatchSubscription('creator', { guildId: 'guild-1', platform: 'x' }), null);
    assert.equal(store.listWatchSubscriptions('creator').length, 6);
    assert.equal(store.listWatchSubscriptions('creator', 'instagram').length, 3);
    assert.deepEqual(store.listWatchSubscriptions('creator', 'x'), []);

    store.db.exec('DROP TABLE watch_subscriptions');
    assert.throws(() => store.listWatchesForScope({ ...scope, platform: 'instagram' }), /no such table/);
  } finally {
    store.close();
  }
});

test('removing a watch preserves other platforms and remaining guild subscriptions', () => {
  const store = new Store(':memory:');
  try {
    for (const platform of ['tiktok', 'instagram']) {
      for (const guildId of ['guild-1', 'guild-2']) {
        store.addWatch('creator', { platform, guildId, channelId: 'channel-1' }, 1000);
      }
    }
    const instagram = store.getWatch('creator', 'instagram');
    assert.equal(store.removeWatch('creator'), true);
    assert.equal(store.removeWatch('creator'), false);
    assert.equal(store.getWatch('creator'), null);
    assert.deepEqual(store.listWatchSubscriptions('creator', 'tiktok'), []);
    assert.deepEqual(store.getWatch('creator', 'instagram'), instagram);
    assert.equal(store.listWatchSubscriptions('creator', 'instagram').length, 2);
    assert.equal(store.removeWatch('creator', { platform: 'instagram', guildId: 'guild-1' }), true);
    assert.deepEqual(store.getWatch('creator', 'instagram'), instagram);
    assert.equal(store.listWatchSubscriptions('creator', 'instagram').length, 1);
    assert.equal(store.removeWatch('creator', { platform: 'instagram', guildId: 'guild-2' }), true);
    assert.equal(store.getWatch('creator', 'instagram'), null);
  } finally {
    store.close();
  }
});

test('poll outcomes only update the requested platform, including when its watch is missing', () => {
  const store = new Store(':memory:');
  try {
    for (const platform of ['tiktok', 'instagram']) {
      store.addWatch('creator', { platform, channelId: 'channel-1' }, 1000);
    }
    const initialTikTok = store.getWatch('creator', 'tiktok');
    store.markWatchFailure('creator', 'failed', 3000, 2000, 'instagram');
    assert.equal(store.getWatch('creator', 'instagram').failure_count, 1);
    assert.deepEqual(store.getWatch('creator', 'tiktok'), initialTikTok);
    store.markWatchSuccess('creator', 4000, 5000, 'instagram');
    const instagram = store.getWatch('creator', 'instagram');
    assert.equal(instagram.failure_count, 0);
    assert.equal(instagram.last_error, null);
    assert.equal(instagram.last_success_at, 4000);
    assert.equal(instagram.next_check_at, 5000);
    assert.deepEqual(store.getWatch('creator', 'tiktok'), initialTikTok);

    store.markWatchFailure('creator', 'missing watch', 6000, 5000, 'x');
    store.markWatchSuccess('creator', 6000, 7000, 'x');
    assert.deepEqual(store.getWatch('creator', 'instagram'), instagram);
    assert.deepEqual(store.getWatch('creator', 'tiktok'), initialTikTok);

    store.markWatchFailure('creator', 'legacy caller', 8000, 7000);
    assert.equal(store.getWatch('creator', 'tiktok').failure_count, 1);
    store.markWatchSuccess('creator', 8000, 9000);
    assert.equal(store.getWatch('creator', 'tiktok').last_success_at, 8000);
    assert.deepEqual(store.getWatch('creator', 'instagram'), instagram);
  } finally {
    store.close();
  }
});

test('highlight outcomes remain scoped and database errors propagate', () => {
  const store = new Store(':memory:');
  try {
    for (const platform of ['tiktok', 'instagram']) {
      store.addWatch('creator', { platform, channelId: 'channel-1' }, 1000);
    }
    const initialTikTok = store.getWatch('creator', 'tiktok');
    store.markHighlightCheckFailure('creator', 'instagram', 'failed', 3000, 2000);
    assert.equal(store.getWatch('creator', 'instagram').highlight_failure_count, 1);
    store.markHighlightCheckSuccess('creator', 'instagram', 4000, 5000);
    assert.equal(store.getWatch('creator', 'instagram').highlight_failure_count, 0);
    assert.equal(store.getWatch('creator', 'instagram').next_highlight_check_at, 5000);
    assert.deepEqual(store.getWatch('creator', 'tiktok'), initialTikTok);

    store.db.exec(`
      CREATE TRIGGER reject_instagram_update BEFORE UPDATE ON watched_users
      WHEN OLD.platform = 'instagram'
      BEGIN SELECT RAISE(FAIL, 'write rejected'); END;
    `);
    assert.throws(() => store.markWatchSuccess('creator', 6000, 7000, 'instagram'), /write rejected/);
    assert.throws(() => store.markWatchFailure('creator', 'failed', 7000, 6000, 'instagram'), /write rejected/);
    assert.throws(() => store.markHighlightCheckSuccess('creator'), /write rejected/);
    assert.throws(() => store.markHighlightCheckFailure('creator'), /write rejected/);
    assert.deepEqual(store.getWatch('creator', 'tiktok'), initialTikTok);
  } finally {
    store.close();
  }
});

test('Instagram and X files cannot make a TikTok seen post eligible for deletion checks', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-archive-monitor-platform-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const remoteId = 'same-remote-id';
    store.addWatch('creator', { guildId: 'guild-1', channelId: 'channel-1' }, 1000);
    store.markVideoSeen({
      videoId: remoteId,
      username: 'creator',
      sourceUrl: `https://www.tiktok.com/@creator/video/${remoteId}`,
      title: 'TikTok post',
      alertedAt: 1000,
    }, 1000);

    const xFileId = store.createFileRecord({
      platform: 'x',
      videoId: remoteId,
      username: 'creator',
      sourceUrl: `https://x.com/creator/status/${remoteId}`,
      filePath: path.join(dir, 'x.mp4'),
      filename: 'x.mp4',
      sizeBytes: 1,
    }, 1100);
    store.createLinkToken({
      token: 'x-monitor-token',
      fileId: xFileId,
      scopeId: 'guild:guild-1',
      deliveryType: 'monitor',
      expiresAt: 0,
    }, 1100);

    assert.equal(store.backfillDeletionChecks(2000), 0);
    assert.equal(store.getLatestPermanentTokenForVideo(remoteId, { scopeId: 'guild:guild-1' }), '');
    store.scheduleVideoDeletionCheck(remoteId, 2000);
    assert.deepEqual(store.listVideosDueForDeletionCheck(2000), []);
    store.db.prepare('UPDATE seen_videos SET next_deletion_check_at = NULL WHERE video_id = ?').run(remoteId);

    const tiktokFileId = store.createFileRecord({
      platform: 'tiktok',
      videoId: remoteId,
      username: 'creator',
      sourceUrl: `https://www.tiktok.com/@creator/video/${remoteId}`,
      filePath: path.join(dir, 'tiktok.mp4'),
      filename: 'tiktok.mp4',
      sizeBytes: 1,
    }, 1200);
    store.createLinkToken({
      token: 'tiktok-monitor-token',
      fileId: tiktokFileId,
      scopeId: 'guild:guild-1',
      deliveryType: 'monitor',
      expiresAt: 0,
    }, 1200);

    assert.equal(store.backfillDeletionChecks(3000), 1);
    const due = store.listVideosDueForDeletionCheck(3000);
    assert.equal(due.length, 1);
    assert.equal(due[0].permanent_token, 'tiktok-monitor-token');
    assert.equal(due[0].filename, 'tiktok.mp4');
    assert.equal(
      store.getLatestPermanentTokenForVideo(remoteId, { scopeId: 'guild:guild-1' }),
      'tiktok-monitor-token',
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('removing same-ID Instagram or X files never resets TikTok deletion state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-archive-monitor-reset-'));
  const store = createStore(path.join(dir, 'state.db'));
  const remoteId = 'shared-id';
  const scheduledAt = 9000;
  try {
    store.markVideoSeen({
      videoId: remoteId,
      username: 'creator',
      sourceUrl: `https://www.tiktok.com/@creator/video/${remoteId}`,
      title: 'TikTok post',
      alertedAt: 1000,
    }, 1000);
    const reschedule = () => store.scheduleVideoDeletionCheck(remoteId, scheduledAt);
    const nextCheck = () => store.db.prepare(`
      SELECT next_deletion_check_at FROM seen_videos WHERE video_id = ?
    `).get(remoteId)?.next_deletion_check_at;

    reschedule();
    const instagramFileId = createTestFile(store, dir, 'instagram', remoteId, 'instagram.jpg', 1100);
    assert.equal(store.deleteFileRecords([instagramFileId]), 1);
    assert.equal(nextCheck(), scheduledAt);

    reschedule();
    const xDeliveryFileId = createTestFile(store, dir, 'x', remoteId, 'x.mp4', 1200);
    store.createLinkToken({ token: 'x-delete', fileId: xDeliveryFileId, expiresAt: 0 }, 1200);
    assert.deepEqual(
      store.deleteDeliveryToken('x-delete', { deleteFile: true, now: 1300 }),
      { files: 1, links: 1, jobs: 0 },
    );
    assert.equal(nextCheck(), scheduledAt);

    reschedule();
    const xPurgeFileId = createTestFile(store, dir, 'x', remoteId, 'x-purge.mp4', 1400);
    assert.deepEqual(
      store.purgeDownloads({ removeFileIds: [xPurgeFileId], now: 1500 }),
      { files: 1, links: 0, jobs: 0 },
    );
    assert.equal(nextCheck(), scheduledAt);

    const tiktokFileId = createTestFile(store, dir, 'tiktok', remoteId, 'tiktok.mp4', 1600);
    assert.equal(store.deleteFileRecords([tiktokFileId]), 1);
    assert.equal(nextCheck(), null);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function createTestFile(store, dir, platform, videoId, filename, now) {
  return store.createFileRecord({
    platform,
    videoId,
    username: 'creator',
    sourceUrl: `https://example.test/${platform}/${videoId}`,
    filePath: path.join(dir, filename),
    filename,
    sizeBytes: 1,
  }, now);
}

test('monitor download failures retain their platform across retries', () => {
  const store = new Store(':memory:');
  try {
    const record = { videoId: 'story_123', username: 'creator', platform: 'instagram', sourceUrl: 'https://www.instagram.com/stories/creator/123/' };
    assert.equal(store.recordMonitorDownloadFailure(record, 5, 1000).platform, 'instagram');
    assert.equal(store.recordMonitorDownloadFailure({ videoId: 'story_123', error: 'again' }, 5, 2000).platform, 'instagram');
    assert.equal(store.recordMonitorDownloadFailure({ videoId: '123', username: 'creator' }, 5, 1000).platform, 'tiktok');
  } finally { store.close(); }
});
