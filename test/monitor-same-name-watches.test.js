import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/state/store.js';
import { TikTokMonitor } from '../src/tiktok/monitor.js';

const username = 'fixture_shared';
const storyId = 'story_fixture_shared';

function fixture({ instagramDue = 0, tiktokDue = 0, failPlatform = '' } = {}) {
  const store = new Store(':memory:');
  for (const [platform, due] of [['instagram', instagramDue], ['tiktok', tiktokDue]]) {
    store.addWatch(username, { platform, channelId: `${platform}-fixture-channel` }, 0);
    store.db.prepare('UPDATE watched_users SET next_check_at = ? WHERE platform = ? AND username = ?')
      .run(due, platform, username);
  }
  let now = 1000;
  const storyChecks = [];
  const downloads = [];
  const alerts = [];
  const monitor = new TikTokMonitor({
    store,
    pollIntervalMs: 300000,
    now: () => now,
    logger: { info() {}, warn() {}, error() {} },
    downloader: {
      listProfileVideos: async (_url, { watch }) => {
        if (watch.platform === failPlatform) throw new Error('fixture profile failure');
        return { entries: [] };
      },
      listProfileStories: async (_url, { watch }) => {
        storyChecks.push(watch.platform);
        return { entries: watch.platform === 'instagram' ? [{
          id: storyId,
          mediaType: 'story',
          url: `https://www.instagram.com/stories/${username}/123456789/`,
        }] : [] };
      },
      downloadVideo: async (video, options) => {
        downloads.push({ id: video.id, platform: options.platform });
        return { mediaType: 'story', filename: 'fixture.mp4' };
      },
    },
    alert: async ({ watch, video }) => alerts.push({ id: video.id, platform: watch.platform }),
  });
  return { store, monitor, storyChecks, downloads, alerts, advance: value => { now = value; } };
}

test('repeated TikTok polls cannot postpone a same-name Instagram Story download and alert', async () => {
  const f = fixture({ instagramDue: 500000 });
  try {
    const instagramBefore = f.store.getWatch(username, 'instagram');
    for (const now of [1000, 301001]) {
      f.advance(now);
      const result = await f.monitor.runOnce({ waitForDownloads: true });
      assert.equal(result.watchedUsers, 1);
      assert.equal(result.failures, 0);
      assert.deepEqual(f.store.getWatch(username, 'instagram'), instagramBefore);
      assert.equal(f.store.getWatch(username, 'tiktok').last_success_at, now);
    }

    const tiktokBefore = f.store.getWatch(username, 'tiktok');
    f.advance(500001);
    const result = await f.monitor.runOnce({ waitForDownloads: true });
    assert.equal(result.watchedUsers, 1);
    assert.equal(result.downloadedVideos, 1);
    assert.equal(result.alertedVideos, 1);
    assert.equal(result.failures, 0);
    assert.deepEqual(f.storyChecks, ['tiktok', 'tiktok', 'instagram']);
    assert.deepEqual(f.downloads, [{ id: storyId, platform: 'instagram' }]);
    assert.deepEqual(f.alerts, f.downloads);
    assert.equal(f.store.hasSeenVideo(storyId), true);
    assert.equal(f.store.getWatch(username, 'instagram').last_success_at, 500001);
    assert.deepEqual(f.store.getWatch(username, 'tiktok'), tiktokBefore);
  } finally { f.monitor.stop(); f.store.close(); }
});

for (const platform of ['tiktok', 'instagram']) {
  test(`${platform} profile failure cannot back off the same-name watch on the other platform`, async () => {
    const other = platform === 'tiktok' ? 'instagram' : 'tiktok';
    const f = fixture({
      instagramDue: platform === 'instagram' ? 0 : 999999,
      tiktokDue: platform === 'tiktok' ? 0 : 999999,
      failPlatform: platform,
    });
    try {
      const otherBefore = f.store.getWatch(username, other);
      const result = await f.monitor.runOnce({ waitForDownloads: true });
      assert.equal(result.failures, 1);
      assert.equal(f.store.getWatch(username, platform).failure_count, 1);
      assert.equal(f.store.getWatch(username, platform).last_checked_at, 1000);
      assert.ok(f.store.getWatch(username, platform).next_check_at > 1000);
      assert.deepEqual(f.store.getWatch(username, other), otherBefore);
      assert.deepEqual(f.downloads, []);
      assert.deepEqual(f.alerts, []);
    } finally { f.monitor.stop(); f.store.close(); }
  });
}

test('a forced Instagram run downloads its Story without changing the same-name TikTok schedule', async () => {
  const f = fixture({ instagramDue: 999999, tiktokDue: 999999 });
  try {
    const tiktokBefore = f.store.getWatch(username, 'tiktok');
    const result = await f.monitor.pollUsername(username, { force: true, platform: 'instagram' });
    assert.equal(result.newVideos, 1);
    assert.deepEqual(f.storyChecks, ['instagram']);
    assert.deepEqual(f.downloads, [{ id: storyId, platform: 'instagram' }]);
    assert.deepEqual(f.alerts, f.downloads);
    assert.deepEqual(f.store.getWatch(username, 'tiktok'), tiktokBefore);
  } finally { f.monitor.stop(); f.store.close(); }
});

test('an invalid Instagram watch still records its normalization failure as Instagram', async () => {
  const calls = [];
  const monitor = new TikTokMonitor({
    store: {
      listWatches: () => [{ platform: 'instagram', username: '', next_check_at: 0 }],
      markWatchFailure: (...args) => calls.push(args),
    },
    downloader: { listProfileVideos: async () => { throw new Error('Invalid watch must fail before listing'); }, downloadVideo: async () => {} },
    now: () => 1000,
    logger: { info() {}, warn() {}, error() {} },
  });
  try {
    const result = await monitor.runOnce();
    assert.equal(result.failures, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][4], 'instagram');
  } finally { monitor.stop(); }
});
