/** LIVE messages use the existing Discord client; never allow mention pings. */
async function send(client, channelId, content) {
  if (!channelId) return false;
  if (!client?.channels?.fetch) throw new Error('Discord client is not ready.');
  const channel = await client.channels.fetch(channelId);
  if (typeof channel?.send !== 'function') throw new Error('LIVE channel is not writable.');
  await channel.send({ content, allowedMentions: { parse: [] } });
  return true;
}

export function formatLiveDuration(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return 'unknown';
  const total = Math.round(n);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${secs}s` : `${secs}s`;
}

export async function sendLiveStarted({ client, channelId, session }) {
  const lines = [
    '🔴 **TikTok LIVE recording started**',
    `Creator: @${session.username}`,
    `LIVE: ${session.sourceUrl}`,
    ...(session.title ? [`Title: ${String(session.title).slice(0, 200)}`] : []),
    'The archive link will be posted after the recording has been saved.',
  ];
  return send(client, channelId, lines.join('\n'));
}

export async function sendLiveArchived({ client, channelId, session, publicUrl }) {
  const size = Number(session.sizeBytes);
  const lines = [
    '📼 **TikTok LIVE archived**',
    `Creator: @${session.username}`,
    `Duration: ${formatLiveDuration(session.durationSeconds)}`,
    ...(Number.isFinite(size) && size > 0 ? [`Size: ${(size / 1024 ** 2).toFixed(1)} MB`] : []),
    ...(session.partial ? ['⚠️ Partial recording: the source ended unexpectedly, recording was interrupted, or a segment limit was reached.'] : []),
    ...(publicUrl ? [`Archive: ${publicUrl}`] : []),
    `LIVE page: ${session.sourceUrl}`,
  ];
  return send(client, channelId, lines.join('\n'));
}
