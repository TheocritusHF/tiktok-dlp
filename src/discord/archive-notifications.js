import { resolveMonitorDeliveryScope, sendVideoAlert } from './client.js';

function guildIdOf(channel) {
  return String(channel?.guildId ?? channel?.guild?.id ?? '');
}

async function hasWatchInGuild(client, subscriptions, guildId) {
  for (const subscription of subscriptions) {
    const scope = await resolveMonitorDeliveryScope(client, subscription);
    if (scope.guildId === guildId && !scope.guildId.startsWith('dm:')) return subscription;
  }
  return null;
}

/** Optional archive copy. Never route a DM or another server's watch to a global channel. */
export async function sendDedicatedMonitorAlert({
  client, config, store, downloadService, result, video, watch, targets, platform,
}) {
  if (platform !== 'tiktok') return false;
  const mediaType = String(video?.mediaType ?? result?.mediaType ?? '').toLowerCase();
  const channelId = String(mediaType === 'story'
    ? config.discordNewStoriesChannelId ?? ''
    : config.discordNewVideosChannelId ?? '').trim();
  if (!channelId) return false;

  const channel = await client.channels.fetch(channelId);
  const guildId = guildIdOf(channel);
  if (!guildId || typeof channel?.send !== 'function') {
    throw new Error('The configured archive notification channel must be a text channel in a server.');
  }
  const subscription = await hasWatchInGuild(client, targets, guildId);
  if (!Number.isInteger(Number(subscription?.id)) || Number(subscription.id) <= 0
    || String(subscription.channel_id ?? '') === channelId) return false;

  const videoId = String(video?.id ?? video?.video_id ?? result?.videoId ?? '');
  const key = videoId
    ? { videoId, subscriptionId: Number(subscription.id), eventType: 'archive_copy' }
    : null;
  if (key && store.isAlertDelivered?.(key)) return false;
  try {
    const scopedResult = await downloadService.createDeliveryForAsset(result, {
      type: 'monitor', guildId, channelId, scopeId: `channel:${channelId}`, permanent: true,
    });
    await sendVideoAlert({
      client, config, result: scopedResult, video,
      watch: { ...watch, channel_id: channelId },
    });
    if (key) store.markAlertDelivered?.(key);
    return true;
  } catch (error) {
    if (key) store.markAlertDeliveryFailed?.({ ...key, error });
    throw error;
  }
}

/** Only report a committed, measured improvement to a server that watches this creator. */
export async function sendQualityUpgradeAlert({ client, config, store, upgrade }) {
  const channelId = String(config.discordQualityUpgradesChannelId ?? '').trim();
  if (!channelId) return false;
  const channel = await client.channels.fetch(channelId);
  const guildId = guildIdOf(channel);
  if (!guildId || typeof channel?.send !== 'function') {
    throw new Error('The configured quality-upgrades channel must be a text channel in a server.');
  }
  const subscriptions = store.listWatchSubscriptions?.(upgrade.username, 'tiktok') ?? [];
  if (!await hasWatchInGuild(client, subscriptions, guildId)) return false;

  const username = String(upgrade?.username ?? '').replace(/[^A-Za-z0-9._]/g, '');
  const videoId = String(upgrade?.videoId ?? '').replace(/[^0-9]/g, '');
  const sourceUrl = String(upgrade.sourceUrl ?? '');
  const url = /^https:\/\/www\.tiktok\.com\/@[A-Za-z0-9._]+\/video\/\d+(?:[?#].*)?$/.test(sourceUrl)
    ? sourceUrl
    : username && videoId ? `https://www.tiktok.com/@${username}/video/${videoId}` : '';
  const from = upgrade?.previous ?? {};
  const to = upgrade?.current ?? {};
  const width = Number(to.width);
  const height = Number(to.height);
  if (![Number(from.width), Number(from.height), width, height].every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error('Cannot notify about an upgrade without verified dimensions.');
  }
  const stage = ['6h', '24h', '72h'].includes(upgrade?.stage) ? upgrade.stage : 'scheduled';
  const codec = String(to.codec ?? '').replace(/[^A-Za-z0-9._-]/g, '');
  const lines = [
    '✅ **TikTok video quality upgraded**',
    username ? `Account: @${username}` : `Video: ${videoId || 'unknown'}`,
    `Quality: ${Number(from.width)}×${Number(from.height)} → ${width}×${height}${codec ? ` (${codec})` : ''}`,
    `Check: ${stage}`,
    ...(url ? [`Post: ${url}`] : []),
  ];
  await channel.send({ content: lines.join('\n'), allowedMentions: { parse: [] } });
  return true;
}
