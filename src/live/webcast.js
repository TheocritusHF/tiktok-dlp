import { spawn } from 'node:child_process';
import path from 'node:path';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { cookieHeaderForUrl, loadTikTokCookieSession } from '../tiktok/cookies.js';
import { largestRecordedFile, liveUrl } from './yt-dlp.js';

const CDN_DOMAINS = [
  'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com',
  'ttlivecdn.com', 'tiktokv.com', 'pstatp.com',
];

export function safeWebcastStreamUrl(value) {
  try {
    const url = new URL(String(value));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !CDN_DOMAINS.some((domain) => host === domain || host.endsWith('.' + domain))) return '';
    return url.href;
  } catch {
    return '';
  }
}

function validRoomId(value) {
  const text = String(value ?? '');
  return /^\d{5,30}$/.test(text) ? text : '';
}

function ownerMatches(value, username) {
  return String(value ?? '').toLowerCase() === String(username).toLowerCase();
}

export function parseWebcastProfile(html, username) {
  const scripts = [
    ['__UNIVERSAL_DATA_FOR_REHYDRATION__', (data) => data?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.user],
    ['SIGI_STATE', (data) => data?.LiveRoom?.liveRoomUserInfo?.user ?? data?.UserModule?.users?.[username]],
  ];
  for (const [id, select] of scripts) {
    const match = String(html).match(new RegExp('<script\\b[^>]*\\bid=["\\x27]' + id
      + '["\\x27][^>]*>([\\s\\S]*?)<\\/script>', 'i'));
    if (!match) continue;
    let user;
    try { user = select(JSON.parse(match[1])); } catch { throw new Error('TikTok LIVE profile data was invalid.'); }
    if (!user || !ownerMatches(user.uniqueId ?? user.unique_id, username)) {
      throw new Error('TikTok LIVE profile did not confirm the requested creator.');
    }
    return validRoomId(user.roomId ?? user.room_id);
  }
  throw new Error('TikTok LIVE profile did not contain verifiable room data.');
}

function streamFromRoom(data) {
  const streams = data?.stream_url ?? {};
  const preference = ['ORIGION', 'ORIGIN', 'FULL_HD1', 'HD1', 'HD', 'SD2', 'SD1', 'LD'];
  const flvUrls = typeof streams.flv_pull_url === 'object' && streams.flv_pull_url !== null
    ? streams.flv_pull_url : { origin: streams.flv_pull_url };
  const flv = Object.entries(flvUrls)
    .sort(([a], [b]) => {
      const rank = (key) => {
        const index = preference.indexOf(key.toUpperCase());
        return index < 0 ? preference.length : index;
      };
      return rank(a) - rank(b);
    })
    .map(([, url]) => url);
  for (const value of [
    ...flv,
    streams.hls_pull_url,
  ]) {
    const safe = safeWebcastStreamUrl(value);
    if (safe) return safe;
  }
  let nested;
  try { nested = JSON.parse(streams.live_core_sdk_data?.pull_data?.stream_data ?? '{}'); } catch { nested = {}; }
  for (const stream of Object.values(nested.data ?? {})) {
    for (const value of [stream?.main?.flv, stream?.main?.hls]) {
      const safe = safeWebcastStreamUrl(value);
      if (safe) return safe;
    }
  }
  return '';
}

export function parseWebcastRoom(payload, username, expectedRoomId) {
  const data = payload?.data;
  if (!data || validRoomId(data.id ?? data.room_id) !== expectedRoomId) {
    throw new Error('TikTok webcast did not confirm the requested room.');
  }
  const owner = data.ownerInfo?.uniqueId ?? data.owner?.display_id ?? data.owner?.unique_id;
  if (!ownerMatches(owner, username)) throw new Error('TikTok webcast room owner did not match.');
  if (Number(data.status) === 4) return null;
  if (Number(data.status) !== 2) throw new Error('TikTok webcast returned an unknown LIVE status.');
  const streamUrl = streamFromRoom(data);
  if (!streamUrl) throw new Error('TikTok webcast supplied no supported HTTPS stream.');
  return {
    roomId: expectedRoomId, title: String(data.title ?? '').slice(0, 500),
    source: 'webcast', streamUrl,
  };
}

async function boundedText(response, maxBytes) {
  if (!response?.ok) throw new Error('TikTok webcast request failed (HTTP ' + (response?.status ?? 'unknown') + ').');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error('TikTok webcast response exceeded its size limit.');
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

/** Only call after yt-dlp reports offline. Never persist or log signed stream URLs. */
export async function probeWebcastLive(username, config, { fetchImpl = undiciFetch } = {}) {
  const pageUrl = liveUrl(username);
  const profileUrl = pageUrl.slice(0, -'/live'.length);
  const cookies = await loadTikTokCookieSession({ cookiesFile: config.liveCookiesFile });
  let dispatcher = null;
  try {
    if (config.ytdlpProxy) dispatcher = new ProxyAgent(config.ytdlpProxy);
  } catch {
    throw new Error('Configured LIVE proxy is invalid.');
  }
  const request = async (url, maxBytes) => {
    const cookie = cookieHeaderForUrl(cookies.cookies, url, { includeTikTokSession: true });
    const response = await fetchImpl(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(config.liveProbeTimeoutMs ?? 35_000),
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; TikTokLiveArchive/1.0)',
        accept: 'text/html,application/json',
        ...(cookie ? { cookie } : {}),
      },
      ...(dispatcher ? { dispatcher } : {}),
    });
    return boundedText(response, maxBytes);
  };
  try {
    const html = await request(profileUrl, 2 * 1024 * 1024);
    let id;
    try {
      id = parseWebcastProfile(html, username);
    } catch (error) {
      if (!/verifiable room data|profile data was invalid/.test(error.message)) throw error;
      id = parseWebcastProfile(await request(pageUrl, 2 * 1024 * 1024), username);
    }
    if (!id) return null;
    const endpoint = new URL('https://webcast.tiktok.com/webcast/room/info');
    endpoint.searchParams.set('aid', '1988');
    endpoint.searchParams.set('room_id', id);
    let payload;
    try {
      payload = JSON.parse(await request(endpoint.href, 1024 * 1024));
    } catch {
      throw new Error('TikTok webcast room data was invalid or unavailable.');
    }
    return parseWebcastRoom(payload, username, id);
  } finally {
    await dispatcher?.close();
  }
}

/** FFmpeg copies the original stream to a recoverable Matroska file. */
export function captureWebcastLive(session, _config, {
  streamUrl, onFirstData = () => {}, logger = console, spawnImpl = spawn,
} = {}) {
  const safe = safeWebcastStreamUrl(streamUrl);
  if (!safe) throw new Error('Invalid TikTok webcast stream URL.');
  let child;
  try {
    child = spawnImpl('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', safe, '-map', '0:v:0', '-map', '0:a?',
      '-c', 'copy', '-f', 'matroska', path.join(session.stagingDir, 'recording.mkv'),
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  } catch {
    throw new Error('FFmpeg could not start.');
  }
  let stopped = false;
  let started = false;
  let stopTimer = null;
  const timer = setInterval(() => {
    void largestRecordedFile(session.stagingDir).then((file) => {
      if (!stopped && !started && file?.bytes >= 64 * 1024) {
        started = true;
        return Promise.resolve(onFirstData());
      }
    }).catch(() => logger.warn?.('[live] Webcast file check failed.'));
  }, 5_000);
  timer.unref?.();
  // FFmpeg may echo a signed input URL on stderr. Never log or journal it.
  child.stderr?.resume();
  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      stopped = true;
      clearInterval(timer);
      clearTimeout(stopTimer);
      resolve({ ...result, started });
    };
    child.once('error', () => finish({ code: null, error: 'FFmpeg could not start.' }));
    child.once('close', (code, signal) => finish({ code, signal }));
  });
  return {
    done,
    stop: () => {
      if (stopped || child.exitCode !== null) return;
      try { child.kill('SIGINT'); } catch { /* Child may already be exiting. */ }
      if (!stopTimer) {
        stopTimer = setTimeout(() => {
          if (!stopped) child.kill('SIGTERM');
        }, 12_000);
        stopTimer.unref?.();
      }
    },
  };
}
