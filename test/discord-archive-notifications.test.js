import assert from 'node:assert/strict';
import test from 'node:test';
import { sendDedicatedMonitorAlert, sendQualityUpgradeAlert } from '../src/discord/archive-notifications.js';

function mockClient() {
  const messages = [];
  const channels = new Map([
    ['watch', { id: 'watch', guildId: 'guild-a', send: async (payload) => messages.push(['watch', payload]) }],
    ['videos', { id: 'videos', guildId: 'guild-a', send: async (payload) => messages.push(['videos', payload]) }],
    ['stories', { id: 'stories', guildId: 'guild-a', send: async (payload) => messages.push(['stories', payload]) }],
    ['quality', { id: 'quality', guildId: 'guild-a', send: async (payload) => messages.push(['quality', payload]) }],
    ['other-guild', { id: 'other-guild', guildId: 'guild-b', send: async (payload) => messages.push(['other', payload]) }],
  ]);
  return { client: { channels: { fetch: async (id) => channels.get(id) ?? null } }, messages };
}

function monitorFixture(mediaType = 'video') {
  const { client, messages } = mockClient();
  const created = [];
  const delivered = new Set();
  const failures = [];
  const store = {
    isAlertDelivered: (key) => delivered.has(`${key.videoId}:${key.subscriptionId}:${key.eventType}`),
    markAlertDelivered: (key) => delivered.add(`${key.videoId}:${key.subscriptionId}:${key.eventType}`),
    markAlertDeliveryFailed: (failure) => failures.push(failure),
  };
  const downloadService = {
    createDeliveryForAsset: async (asset, options) => {
      created.push(options);
      return { ...asset, token: 'dedicated-token', publicUrl: 'https://archive.example.test/files/dedicated-token' };
    },
  };
  const args = {
    client,
    config: {
      discordNewVideosChannelId: 'videos', discordNewStoriesChannelId: 'stories',
      publicBaseUrl: 'https://archive.example.test',
    },
    store, downloadService,
    result: { fileId: 5, videoId: 'post-1', mediaType, sizeBytes: 100 },
    video: { id: 'post-1', mediaType, title: 'Example', sourceUrl: 'https://www.tiktok.com/@creator/video/123' },
    watch: { username: 'creator' },
    targets: [{ id: 7, guild_id: 'guild-a', channel_id: 'watch' }],
    platform: 'tiktok',
  };
  return { args, messages, created, delivered, failures };
}

test('monitored videos send one separately scoped copy without changing the watch channel', async () => {
  const { args, messages, created, delivered } = monitorFixture();
  assert.equal(await sendDedicatedMonitorAlert(args), true);
  assert.deepEqual(messages.map(([id]) => id), ['videos']);
  assert.equal(created.length, 1);
  assert.equal(created[0].scopeId, 'channel:videos');
  assert.equal(created[0].guildId, 'guild-a');
  assert.deepEqual([...delivered], ['post-1:7:archive_copy']);
  assert.equal(await sendDedicatedMonitorAlert(args), false);
  assert.equal(messages.length, 1);
});

test('a failed dedicated send remains separate from the account delivery state', async () => {
  const { args, messages, delivered, failures } = monitorFixture();
  const fetch = args.client.channels.fetch;
  args.client.channels.fetch = async (id) => {
    const channel = await fetch(id);
    return id === 'videos'
      ? { ...channel, send: async () => { throw new Error('Discord denied this channel'); } }
      : channel;
  };
  await assert.rejects(sendDedicatedMonitorAlert(args), /Discord denied this channel/);
  assert.equal(messages.length, 0);
  assert.equal(delivered.size, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].eventType, 'archive_copy');
});

test('Stories use their own channel and a matching watch channel is not duplicated', async () => {
  const { args, messages } = monitorFixture('story');
  assert.equal(await sendDedicatedMonitorAlert(args), true);
  assert.deepEqual(messages.map(([id]) => id), ['stories']);
  args.targets[0].channel_id = 'stories';
  assert.equal(await sendDedicatedMonitorAlert(args), false);
  assert.equal(messages.length, 1);
});

test('dedicated copies exclude DM watches, other servers, and non-TikTok posts', async () => {
  const { args, messages, created } = monitorFixture();
  args.targets = [{ id: 8, guild_id: 'dm:private', channel_id: 'private' }];
  assert.equal(await sendDedicatedMonitorAlert(args), false);
  args.targets = [{ id: 9, guild_id: 'guild-b', channel_id: 'other-guild' }];
  assert.equal(await sendDedicatedMonitorAlert(args), false);
  args.platform = 'instagram';
  args.targets = [{ id: 7, guild_id: 'guild-a', channel_id: 'watch' }];
  assert.equal(await sendDedicatedMonitorAlert(args), false);
  args.platform = 'tiktok';
  args.targets = [{ guild_id: 'guild-a', channel_id: 'watch' }];
  assert.equal(await sendDedicatedMonitorAlert(args), false);
  assert.equal(messages.length, 0);
  assert.equal(created.length, 0);
});

test('quality upgrade notice goes only to a server still watching that creator', async () => {
  const { client, messages } = mockClient();
  const args = {
    client,
    config: { discordQualityUpgradesChannelId: 'quality' },
    store: { listWatchSubscriptions: () => [{ guild_id: 'guild-a', channel_id: 'watch' }] },
    upgrade: {
      username: 'creator', videoId: '123', sourceUrl: 'https://www.tiktok.com/@creator/video/123',
      previous: { width: 576, height: 1024 }, current: { width: 1080, height: 1920, codec: 'hevc' }, stage: '6h',
    },
  };
  assert.equal(await sendQualityUpgradeAlert(args), true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0][0], 'quality');
  assert.deepEqual(messages[0][1].allowedMentions, { parse: [] });
  assert.deepEqual(messages[0][1], {
    content: [
      '✅ **TikTok video quality upgraded**',
      'Account: @creator',
      'Quality: 576×1024 → 1080×1920 (hevc)',
      'Check: 6h',
      'Post: https://www.tiktok.com/@creator/video/123',
    ].join('\n'),
    allowedMentions: { parse: [] },
  });

  args.store.listWatchSubscriptions = () => [{ guild_id: 'dm:private', channel_id: 'private' }];
  assert.equal(await sendQualityUpgradeAlert(args), false);
  args.store.listWatchSubscriptions = () => [{ guild_id: 'guild-b', channel_id: 'other-guild' }];
  assert.equal(await sendQualityUpgradeAlert(args), false);
  assert.equal(messages.length, 1);
});
