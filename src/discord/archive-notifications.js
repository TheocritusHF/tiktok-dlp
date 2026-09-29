import { EmbedBuilder } from 'discord.js';
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

  const embed = new EmbedBuilder()
    .setTitle('Archived Video Quality Upgraded')
    .setColor(0x2ecc71)
    .addFields(
      { name: 'Creator', value: `@${String(upgrade.username || 'unknown').slice(0, 90)}`, inline: true },
      { name: 'Previous', value: `${upgrade.previous.width}x${upgrade.previous.height}`, inline: true },
      { name: 'New', value: `${upgrade.current.width}x${upgrade.current.height}`, inline: true },
    )
    .setTimestamp(new Date());
  const sourceUrl = String(upgrade.sourceUrl ?? '');
  if (/^https:\/\/(?:www\.)?tiktok\.com\//i.test(sourceUrl)) embed.setURL(sourceUrl);
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  return true;
}
