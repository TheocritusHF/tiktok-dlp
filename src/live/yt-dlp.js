import { execFile as callbackExecFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const execFile = promisify(callbackExecFile);
const MEDIA_SUFFIX = /\.(?:flv|ts|mp4|mkv|webm)(?:\.part)?$/i;

export function liveUrl(username) {
  if (!/^[a-z0-9._]{1,32}$/i.test(username) || username.includes('..') || username.startsWith('.') || username.endsWith('.')) {
    throw new Error('Invalid TikTok LIVE username.');
  }
  return `https://www.tiktok.com/@${username}/live`;
}

export function parseLiveMetadata(metadata) {
  if (!metadata || (metadata.is_live !== true && metadata.live_status !== 'is_live')) return null;
  const roomId = String(metadata.room_id ?? metadata.id ?? '').trim();
  if (!/^\d{5,30}$/.test(roomId)) throw new Error('A LIVE response had no usable numeric room ID.');
  return {
    roomId,
    title: String(metadata.title ?? '').slice(0, 500),
  };
}

function commonArgs(config) {
  const args = ['--ignore-config', '--no-warnings', '--no-progress',
    '--impersonate', 'chrome', '--socket-timeout', '15',
    '--retries', '1', '--fragment-retries', '2', '--extractor-retries', '1',
    '--no-playlist'];
  if (config.ytdlpProxy) args.push('--proxy', config.ytdlpProxy);
  // This is a private writable copy made by LiveMonitor, never the read-only mounted jar.
  if (config.liveCookiesFile) args.push('--cookies', config.liveCookiesFile);
  return args;
}

export async function probeTikTokLive(username, config) {
  const args = [...commonArgs(config), '--skip-download', '--dump-single-json', '--', liveUrl(username)];
  let stdout;
  try {
    ({ stdout } = await execFile(config.ytdlpPath || 'yt-dlp', args, {
      timeout: config.liveProbeTimeoutMs ?? 35_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    }));
  } catch (error) {
    const details = `${error.stderr ?? ''}\n${error.message ?? ''}`;
    if (/\bnot (?:currently )?live\b|not live right now|the user is offline/i.test(details)) return null;
    throw new Error(`LIVE check for @${username} failed: ${String(error.message).slice(0, 180)}`);
  }
  return parseLiveMetadata(JSON.parse(stdout));
}

export async function largestRecordedFile(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const candidates = await Promise.all(entries.filter((entry) => entry.isFile() && MEDIA_SUFFIX.test(entry.name))
    .map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      const info = await stat(fullPath).catch(() => null);
      return info?.isFile() ? { path: fullPath, bytes: info.size } : null;
    }));
  return candidates.filter(Boolean).sort((a, b) => b.bytes - a.bytes)[0] ?? null;
}

/** A child-process handle; preserves the source bytes even on non-zero yt-dlp exits. */
export function captureTikTokLive(session, config, { onFirstData = () => {}, logger = console } = {}) {
  const args = [...commonArgs(config), '--no-part', '--hls-use-mpegts',
    '--format', 'best[ext=flv]/best',
    '--output', path.join(session.stagingDir, 'recording.%(ext)s'),
    '--', liveUrl(session.username)];
  const child = spawn(config.ytdlpPath || 'yt-dlp', args, {
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  let started = false;
  let stopped = false;
  let stopTimer = null;
  const checkFirstData = async () => {
    if (started || stopped) return;
    const file = await largestRecordedFile(session.stagingDir);
    if (file?.bytes >= 64 * 1024 && !started) {
      started = true;
      Promise.resolve().then(() => onFirstData()).catch((error) =>
        logger.warn?.(`[live] Start notification failed for @${session.username}: ${error.message}`));
    }
  };
  const progressTimer = setInterval(() => {
    void checkFirstData().catch((error) => logger.warn?.(`[live] File check: ${error.message}`));
  }, 5_000);
  progressTimer.unref?.();
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      stopped = true;
      clearInterval(progressTimer);
      clearTimeout(stopTimer);
      resolve({ ...result, started, stderr: stderr.slice(-800) });
    };
    child.once('error', (error) => finish({ code: null, error: error.message }));
    child.once('close', (code, signal) => finish({ code, signal }));
  });
  return {
    done,
    stop: () => {
      if (stopped || child.exitCode !== null) return;
      try { child.kill('SIGINT'); } catch { /* child may already be exiting */ }
      if (!stopTimer) {
        stopTimer = setTimeout(() => {
          if (!stopped) child.kill('SIGTERM');
        }, 12_000);
        stopTimer.unref?.();
      }
    },
  };
}

export async function inspectRecordedMedia(filePath) {
  const { stdout } = await execFile('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration',
    '-of', 'json', filePath,
  ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const data = JSON.parse(stdout);
  const video = data.streams?.find((stream) => stream.codec_type === 'video');
  if (!video || Number(video.width) <= 0 || Number(video.height) <= 0) {
    throw new Error('Recording does not contain a verified video stream.');
  }
  const duration = Number(data.format?.duration);
  return {
    width: Number(video.width), height: Number(video.height),
    duration: Number.isFinite(duration) && duration >= 0 ? duration : null,
  };
}

/** Remux, never re-encode. If MP4 is incompatible try MKV, then a verified raw file. */
export async function remuxRecordedMedia(source, basePath, { inspect = inspectRecordedMedia } = {}) {
  const options = [
    { ext: 'mp4', extra: ['-movflags', '+faststart'] },
    { ext: 'mkv', extra: [] },
  ];
  for (const { ext, extra } of options) {
    const output = `${basePath}.partial.${ext}`;
    try {
      await execFile('ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-fflags', '+genpts', '-err_detect', 'ignore_err', '-i', source,
        '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', ...extra, output,
      ], { timeout: 45 * 60_000, maxBuffer: 512 * 1024 });
      const media = await inspect(output);
      return { tempPath: output, ext, media };
    } catch { /* Leave original alone and attempt the next container. */ }
  }
  const media = await inspect(source);
  const suffix = source.toLowerCase().match(/\.(flv|ts|mp4|mkv|webm)(?:\.part)?$/)?.[1];
  if (!suffix) throw new Error('Cannot safely retain a recording with an unknown format.');
  return { tempPath: source, ext: suffix, media, raw: true };
}
