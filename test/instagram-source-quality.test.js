import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdtemp, rm, copyFile, symlink } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const sourcePath = new URL('../src/platforms/galleryDl.js', import.meta.url).pathname;
let source = await readFile(sourcePath, 'utf8');
source = source.replace(/from '(\.\/[^']+)'/g, (_, relative) => `from '${pathToFileURL(path.resolve(path.dirname(sourcePath), relative)).href}'`);
source += '\nexport { buildDownloadArgs, buildProbeArgs, buildListingCommonArgs, inspectOutputDirectory, galleryDlChildEnv, probeSavedInstagramVideo };\n';
const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const reference = { platform: 'instagram', remoteId: 'story_12345', creatorHandle: 'qualitytest', canonicalUrl: 'https://www.instagram.com/stories/qualitytest/12345/' };
const settings = { maxAssets: 1, maxItemBytes: 1_000_000, maxTotalBytes: 2_000_000, timeoutMs: 3000, spawnImpl: spawn, instagramDash: true };
const runtime = { cookiesFile: '/tmp/cookies.txt', cacheFile: '/tmp/cache.db' };
const opts = (args) => args.filter((_, i) => args[i - 1] === '-o');
let root, fixture, cookie;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'ig-quality-tests-'));
  fixture = path.join(root, 'fixture.mkv');
  cookie = path.join(root, 'cookies.txt');
  await writeFile(cookie, '# Netscape HTTP Cookie File\n.instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\ttest-only\n');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1080x1920:r=1', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '0.2', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-y', fixture]);
});
after(async () => { await rm(root, { recursive: true, force: true }); });
const dir = async () => mkdtemp(path.join(root, 'output-'));
const rejectKind = (kind) => (error) => error.kind === kind;

test('only actual Instagram video downloads request DASH and the isolated module', () => {
  const args = module.buildDownloadArgs(reference, settings, runtime, '/tmp/output', true);
  const options = opts(args);
  assert.equal(options.at(-5), 'extractor.instagram.videos=true');
  assert(options.includes('downloader.ytdl.module=/opt/instagram-dash/yt_dlp'));
  assert(options.includes('downloader.ytdl.format=bestvideo*+bestaudio/best'));
  assert.equal(args.at(-1), reference.canonicalUrl);
});
test('Instagram probe and listing keep merged HTTPS metadata', () => {
  for (const args of [module.buildProbeArgs(reference, settings, runtime), module.buildListingCommonArgs('instagram', settings, runtime, 5)]) {
    assert(opts(args).includes('extractor.instagram.videos=merged'));
    assert(!opts(args).includes('extractor.instagram.videos=true'));
  }
});
test('image downloads and X retain their original video settings', () => {
  assert(!opts(module.buildDownloadArgs(reference, settings, runtime, '/tmp/output')).some((v) => v.startsWith('downloader.ytdl.')));
  const x = { platform: 'x', remoteId: '123', canonicalUrl: 'https://x.com/user/status/123' };
  const options = opts(module.buildDownloadArgs(x, settings, runtime, '/tmp/output'));
  assert(options.includes('extractor.twitter.videos=true'));
  assert(!options.some((v) => v.startsWith('extractor.instagram.')));
});
test('DASH temporary streams and fragments count as one logical asset', async () => {
  const output = await dir();
  for (const name of ['asset_001.fdash-v.webm', 'asset_001.fdash-a.m4a', 'asset_001.fdash-v.webm.ytdl', 'asset_001.fdash-v.webm-Frag1', 'asset_001.temp.mkv']) await writeFile(path.join(output, name), 'test');
  assert.equal((await module.inspectOutputDirectory(output, settings, { allowPartial: true })).length, 5);
});
test('DASH temporary filenames stay rejected for other download modes', async () => {
  const output = await dir(); await writeFile(path.join(output, 'asset_001.fdash-v.webm'), 'test');
  await assert.rejects(module.inspectOutputDirectory(output, { ...settings, instagramDash: false }, { allowPartial: true }), rejectKind('unsafe_artifact'));
});
for (const filename of ['asset_001.fdash-a.m4a', 'asset_001.fdash-v.webm', 'asset_001.webm.ytdl', 'asset_001.mp4.part', 'arbitrary.mp4', 'asset_001.php']) {
  test(`final archive refuses leftover or unexpected artifact ${filename}`, async () => {
    const output = await dir(); await writeFile(path.join(output, filename), 'test');
    await assert.rejects(module.inspectOutputDirectory(output, settings, { expectedCount: 1 }), rejectKind('unsafe_artifact'));
  });
}
test('the per-file size limit still covers DASH intermediate streams', async () => {
  const output = await dir(); await writeFile(path.join(output, 'asset_001.fdash-v.webm'), 'oversize');
  await assert.rejects(module.inspectOutputDirectory(output, { ...settings, maxItemBytes: 2 }, { allowPartial: true }), rejectKind('item_size_limit'));
});
test('the total size limit includes all DASH intermediate bytes', async () => {
  const output = await dir();
  await writeFile(path.join(output, 'asset_001.fv.webm'), 'test'); await writeFile(path.join(output, 'asset_001.fa.m4a'), 'test');
  await assert.rejects(module.inspectOutputDirectory(output, { ...settings, maxTotalBytes: 7 }, { allowPartial: true }), rejectKind('total_size_limit'));
});
test('DASH cannot exceed the logical asset limit', async () => {
  const output = await dir();
  for (const name of ['asset_001.fv.webm', 'asset_002.fa.m4a']) await writeFile(path.join(output, name), 'test');
  await assert.rejects(module.inspectOutputDirectory(output, settings, { allowPartial: true }), rejectKind('asset_limit'));
});
test('DASH rejects symlinks during download', async () => {
  const output = await dir(); await symlink(fixture, path.join(output, 'asset_001.mp4'));
  await assert.rejects(module.inspectOutputDirectory(output, settings, { allowPartial: true }), rejectKind('unsafe_artifact'));
});
test('final output still requires the exact probed asset count', async () => {
  const output = await dir();
  await assert.rejects(module.inspectOutputDirectory(output, settings, { expectedCount: 1 }), rejectKind('incomplete_download'));
});
test('ffprobe reads actual 1080p VP9 dimensions and audio', async () => {
  const result = await module.probeSavedInstagramVideo(fixture, settings);
  assert.equal(result.width, 1080); assert.equal(result.height, 1920);
  assert.equal(result.videoCodec, 'vp9'); assert.equal(result.audioStreams, 1);
});
test('invalid saved video fails instead of persisting stale 720p metadata', async () => {
  const file = path.join(root, 'bad.mp4'); await writeFile(file, 'not a video');
  await assert.rejects(module.probeSavedInstagramVideo(file, settings), rejectKind('media_probe_failed'));
});
test('child processes do not receive Discord or Snapchat credentials', () => {
  const original = process.env.SNAPARCHIVE_API_TOKEN;
  process.env.SNAPARCHIVE_API_TOKEN = 'test-only';
  try { assert(!Object.hasOwn(module.galleryDlChildEnv(), 'SNAPARCHIVE_API_TOKEN')); }
  finally { if (original === undefined) delete process.env.SNAPARCHIVE_API_TOKEN; else process.env.SNAPARCHIVE_API_TOKEN = original; }
  assert(!Object.hasOwn(module.galleryDlChildEnv(), 'DISCORD_TOKEN'));
});
test('full download stages DASH safely, replaces 720p metadata, and cleans temporary cookies', async () => {
  const calls = []; let stagedCookie;
  const spawnImpl = (exe, args, childOptions) => {
    if (exe === 'ffprobe') return spawn(exe, args, childOptions);
    calls.push({ args, childOptions });
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { child.emit('close', null, 'SIGKILL'); return true; };
    setTimeout(async () => {
      try {
        stagedCookie = args[args.indexOf('--cookies') + 1];
        if (args.includes('--dump-json')) {
          child.stdout.emit('data', JSON.stringify([[2, { username: 'qualitytest', type: 'story' }], [3, 'https://cdn.example.com/video.mp4', { extension: 'mp4', type: 'video', width: 720, height: 1280, num: 1 }]]));
        } else {
          const output = args[args.indexOf('--directory') + 1];
          const tempFile = path.join(output, 'asset_001.fdash-a.m4a');
          await writeFile(tempFile, 'temporary audio');
          await new Promise((resolve) => setTimeout(resolve, 220));
          await rm(tempFile); await copyFile(fixture, path.join(output, 'asset_001.mkv'));
        }
        child.emit('close', 0);
      } catch (error) { child.emit('error', error); }
    }, 5);
    return child;
  };
  const result = await module.downloadGalleryDlPost(reference, { instagramCookiesFile: cookie, spawnImpl, galleryDlTempDir: root, galleryDlMaxAssets: 1, galleryDlTimeoutMs: 3000 });
  assert.equal(result.assets[0].height, 1920); assert.equal(result.assets[0].width, 1080);
  assert.equal(result.assets[0].extension, 'mkv'); assert.equal(result.assets[0].audioStreams, 1);
  assert.equal(result.post.height, 1920); assert.equal(result.height, 1920);
  assert.equal(calls.length, 2);
  assert(!opts(calls[0].args).includes('extractor.instagram.videos=true'));
  assert(opts(calls[1].args).includes('extractor.instagram.videos=true'));
  if (process.platform !== 'win32') assert.equal(calls[1].childOptions.detached, true);
  await assert.rejects(readFile(stagedCookie), { code: 'ENOENT' });
  await rm(result.outputDir, { recursive: true, force: true });
});

async function testedDownloadService() {
  return (await import('../src/download/service.js')).DownloadService;
}
for (const platform of ['instagram', 'tiktok']) {
  test(`${platform} persistence and result use the expected metadata precedence`, async () => {
    const DownloadService = await testedDownloadService();
    let record;
    const adapter = {
      platform, capabilities: {},
      canonicalizeUrl: (url) => url.href,
      parsePostReference: () => ({ remoteId: '12345', canonicalUrl: 'https://example.com/post' }),
      download: async () => ({
        remoteId: '12345', filePath: fixture, sizeBytes: 100, duration: 11.1,
        assets: [{ path: fixture, kind: 'video', width: 1080, height: 1920, duration: 11.1 }],
      }),
    };
    const service = new DownloadService({
      config: { downloadDir: root },
      platformRegistry: { forUrl: (url) => ({ adapter, url: new URL(url) }) },
      store: { createJob: () => 1, updateJob: () => {}, getLatestFileByPost: () => null, createFileWithMedia: (value) => { record = value; return { fileId: 1 }; } },
    });
    const result = await service.request('https://example.com/post', { createDelivery: false, metadata: { id: '12345', width: 720, height: 1280, duration: 7 } });
    assert.equal(record.media.assets[0].height, 1920);
    if (platform === 'instagram') {
      assert.equal(result.width, 1080); assert.equal(result.height, 1920);
      assert.equal(result.duration, 11.1); assert.equal(record.media.duration, 11.1);
    } else {
      assert.equal(result.width, 720); assert.equal(result.height, 1280);
      assert.equal(result.duration, 7); assert.equal(record.media.duration, 7);
    }
  });
}

test('local ffprobe measurements remain available during an Instagram account cooldown', async () => {
  const stateDir = await dir();
  await writeFile(path.join(stateDir, 'instagram-account-cooldown.json'), JSON.stringify({ loginUntil: Date.now() + 60_000, rateUntil: 0 }));
  const measured = await module.probeSavedInstagramVideo(fixture, {
    ...settings, platform: 'instagram', accountOptions: { dataDir: stateDir },
  });
  assert.equal(measured.width, 1080);
  assert.equal(measured.height, 1920);
});
