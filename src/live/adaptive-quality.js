import { execFile as callbackExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { liveUrl } from './yt-dlp.js';

const execFile = promisify(callbackExecFile);
const VALID_FORMAT = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** Discover candidates only. Never trust advertised dimensions as proof of quality. */
export async function discoverLiveFormats(username, config) {
  const args = ['--ignore-config', '--no-warnings', '--impersonate', 'chrome',
    '--socket-timeout', '15', '--retries', '1', '--extractor-retries', '1',
    '--skip-download', '--dump-single-json', '--no-playlist'];
  if (config.ytdlpProxy) args.push('--proxy', config.ytdlpProxy);
  if (config.liveCookiesFile) args.push('--cookies', config.liveCookiesFile);
  args.push('--', liveUrl(username));
  const { stdout } = await execFile(config.ytdlpPath || 'yt-dlp', args, {
    timeout: config.liveProbeTimeoutMs || 35_000, maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  const metadata = JSON.parse(stdout);
  if (metadata?.is_live !== true && metadata?.live_status !== 'is_live') return [];
  return rankLiveFormats(metadata.formats ?? []);
}

export function rankLiveFormats(formats) {
  const unique = new Map();
  for (const item of formats) {
    const id = String(item?.format_id ?? '');
    if (!VALID_FORMAT.test(id) || /(?:^|-)ao(?:$|-)/i.test(id)
      || item?.vcodec === 'none') continue;
    const width = Number(item.width) || 0;
    const height = Number(item.height) || 0;
    // Unknown-resolution streams may be excellent; sample them, but after known high resolutions.
    const candidate = { id, width, height, tbr: Number(item.tbr) || 0,
      protocol: String(item.protocol ?? '') };
    if (!unique.has(id)) unique.set(id, candidate);
  }
  return [...unique.values()].sort((a, b) =>
    (b.width * b.height) - (a.width * a.height) || b.tbr - a.tbr);
}

/** Only actual ffprobe measurements can authorize a switch. */
export function qualityImproves(candidate, current) {
  if (!candidate || !current) return false;
  const nextPixels = Number(candidate.width) * Number(candidate.height);
  const currentPixels = Number(current.width) * Number(current.height);
  if (!(nextPixels > 0 && currentPixels > 0)) return false;
  if (nextPixels > currentPixels * 1.05) return true;
  // Avoid trading resolution for a potentially unreliable bitrate estimate.
  if (nextPixels < currentPixels * 0.99) return false;
  const fps = Number(candidate.fps) || 0;
  const previousFps = Number(current.fps) || 0;
  if (fps >= previousFps + 5 && previousFps > 0) return true;
  return previousFps > 0 && fps >= previousFps && Number(current.bitrate) > 0
    && Number(candidate.bitrate) > Number(current.bitrate) * 1.3;
}
