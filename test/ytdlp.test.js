import { access, mkdtemp, chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { spawn as defaultSpawn } from 'node:child_process';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  buildDownloadArgs,
  buildMetadataArgs,
  classifyYtdlpError,
  downloadVideo,
  fetchPhotoPostMetadata,
  fetchVideoMetadata,
  listProfileStories,
  listProfileVideos,
  parsePhotoPostMetadata,
} from '../src/tiktok/ytdlp.js';

const TEST_SEC_UID = `MS4wLjABAAAA${'a'.repeat(64)}`;
const COMPLETE_VIDEO_METADATA = {
  id: '9876543210',
  title: 'A video',
  uploader: 'creator',
  webpage_url: 'https://www.tiktok.com/@creator/video/9876543210',
  extractor_key: 'TikTok',
  formats: [{
    format_id: 'h264',
    url: 'https://cdn.example.test/video.mp4',
    ext: 'mp4',
    vcodec: 'h264',
    acodec: 'aac',
    http_headers: { Referer: 'https://www.tiktok.com/' },
  }],
};

test('buildMetadataArgs builds a conservative metadata command', () => {
  const args = buildMetadataArgs('https://www.tiktok.com/@user/video/123', {
    cookiesFile: '/tmp/cookies.txt',
    ytdlpProxy: 'http://proxy.test:8888',
    extraArgs: ['--extractor-args', 'tiktok:foo=bar'],
  });

  assert.deepStrictEqual(args, [
    '--ignore-config',
    '--no-warnings',
    '--no-progress',
    '--quiet',
    '--socket-timeout',
    '20',
    '--skip-download',
    '--dump-single-json',
    '--user-agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    '--impersonate',
    'chrome',
    '--no-playlist',
    '--proxy',
    'http://proxy.test:8888',
    '--cookies',
    '/tmp/cookies.txt',
    '--extractor-args',
    'tiktok:foo=bar',
    '--',
    'https://www.tiktok.com/@user/video/123',
  ]);

  const playlistArgs = buildMetadataArgs('https://www.tiktok.com/@user', {
    flatPlaylist: true,
    limit: 7,
  });
  assert.deepStrictEqual(playlistArgs.slice(-4), ['--playlist-end', '7', '--', 'https://www.tiktok.com/@user']);
});

test('buildDownloadArgs points yt-dlp at explicit output dirs', () => {
  const args = buildDownloadArgs('https://www.tiktok.com/@user/video/123', {
    outputDir: '/tmp/out',
    cookiesFile: '/tmp/cookies.txt',
    ytdlpProxy: 'http://proxy.test:8888',
    extraArgs: ['--print', 'after_move:filepath'],
  });

  assert.deepStrictEqual(args, [
    '--ignore-config',
    '--no-warnings',
    '--no-progress',
    '--quiet',
    '--newline',
    '--retries',
    '3',
    '--fragment-retries',
    '3',
    '--extractor-retries',
    '3',
    '--retry-sleep',
    'exp=1:30',
    '--socket-timeout',
    '20',
    '--no-playlist',
    '--format',
    'bv*[vcodec^=h264]+ba/b[vcodec^=h264]/bv*[vcodec^=avc]+ba/b[vcodec^=avc]/bv*+ba/b[vcodec!=?none]',
    '--restrict-filenames',
    '--merge-output-format',
    'mp4',
    '--write-info-json',
    '--write-thumbnail',
    '--write-description',
    '--output',
    '%(id)s.%(ext)s',
    '--user-agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    '--impersonate',
    'chrome',
    '--paths',
    'home:/tmp/out',
    '--paths',
    'temp:/tmp/out',
    '--proxy',
    'http://proxy.test:8888',
    '--cookies',
    '/tmp/cookies.txt',
    '--print',
    'after_move:filepath',
    '--',
    'https://www.tiktok.com/@user/video/123',
  ]);

  const overridden = buildDownloadArgs('https://www.tiktok.com/@user/video/123', {
    outputDir: '/tmp/out',
    format: 'bv*+ba/b',
  });
  assert.equal(overridden[overridden.indexOf('--format') + 1], 'bv*+ba/b');

  const fromConfig = buildMetadataArgs('https://www.tiktok.com/@user/video/123', {
    ytdlpCookiesFile: '/app/cookies/tiktok.txt',
  });
  assert.equal(fromConfig.filter((arg) => arg === '--cookies').length, 1);
  assert.equal(fromConfig[fromConfig.indexOf('--cookies') + 1], '/app/cookies/tiktok.txt');

  const bothCookieOptions = buildDownloadArgs('https://www.tiktok.com/@user/video/123', {
    outputDir: '/tmp/out',
    cookiesFile: '/tmp/override.txt',
    ytdlpCookiesFile: '/app/cookies/tiktok.txt',
  });
  assert.equal(bothCookieOptions.filter((arg) => arg === '--cookies').length, 1);
  assert.equal(bothCookieOptions[bothCookieOptions.indexOf('--cookies') + 1], '/tmp/override.txt');
});

test('yt-dlp public download entry points reject unsafe URLs before subprocess or fetch work', async () => {
  let spawnCalls = 0;
  let fetchCalls = 0;
  const spawnImpl = () => {
    spawnCalls += 1;
    throw new Error('must not spawn');
  };
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error('must not fetch');
  };

  await assert.rejects(
    fetchVideoMetadata('http://www.tiktok.com/@creator/video/123', { spawnImpl, fetchImpl }),
    /credential-free HTTPS TikTok URL/i,
  );
  await assert.rejects(
    downloadVideo('https://user:pass@www.tiktok.com/@creator/story/123', {
      metadata: { id: '123', mediaType: 'story', directVideoUrl: 'https://cdn.example.test/story.mp4' },
      fetchImpl,
    }),
    /credential-free HTTPS TikTok URL/i,
  );
  await assert.rejects(
    listProfileVideos('https://example.test/@creator', { spawnImpl }),
    /credential-free HTTPS TikTok URL/i,
  );
  await assert.rejects(
    listProfileStories('https://example.test/no-profile', { fetchImpl }),
    /credential-free HTTPS TikTok URL/i,
  );
  assert.equal(spawnCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('classifyYtdlpError maps common yt-dlp failures', () => {
  assert.equal(classifyYtdlpError({ code: 'ENOENT' }).kind, 'not_installed');
  assert.equal(classifyYtdlpError(new Error('Video unavailable')).kind, 'not_found');
  assert.equal(classifyYtdlpError(new Error('Sign in to confirm your age')).kind, 'auth_required');
  assert.equal(classifyYtdlpError(new Error('Your IP address is blocked from accessing this post')).kind, 'access_blocked');
  const privateWithoutCookies = classifyYtdlpError(new Error('This user’s account is private. Log in or use --cookies.'));
  assert.equal(privateWithoutCookies.kind, 'access_denied');
  assert.equal(privateWithoutCookies.retryable, false);
  assert.match(privateWithoutCookies.message, /not publicly accessible/);

  const privateWithCookies = classifyYtdlpError(
    new Error('You do not have permission to view this post. Log into an account that has access'),
    { ytdlpCookiesFile: '/app/cookies/tiktok.txt' },
  );
  assert.equal(privateWithCookies.kind, 'access_denied');
  assert.equal(privateWithCookies.retryable, false);
  assert.match(privateWithCookies.message, /cookie session cannot access/i);

  const friendsOnlyDenied = classifyYtdlpError(
    new Error('This video is friends-only'),
    { cookiesFile: '/tmp/cookies.txt' },
  );
  assert.equal(friendsOnlyDenied.kind, 'access_denied');
  assert.equal(friendsOnlyDenied.retryable, false);
});

test('fetchVideoMetadata, listProfileVideos, and downloadVideo work with a fake executable', async () => {
  const fake = await createFakeYtDlp();
  const url = 'https://www.tiktok.com/@creator/video/9876543210';

  const metadata = await fetchVideoMetadata(url, { ytdlpPath: fake });
  assert.equal(metadata.id, '9876543210');
  assert.equal(metadata.title, 'A video');
  assert.equal(metadata.uploader, 'creator');

  const profile = await listProfileVideos('https://www.tiktok.com/@creator', { ytdlpPath: fake });
  assert.equal(profile.count, 2);
  assert.equal(profile.entries[0].videoId, '111');
  assert.equal(profile.entries[1].title, 'Second');

  const cachedProfile = await listProfileVideos('https://www.tiktok.com/@creator', {
    ytdlpPath: fake,
    username: 'creator',
    watch: { sec_uid: TEST_SEC_UID },
  });
  assert.equal(cachedProfile.sourceUrl, `tiktokuser:${TEST_SEC_UID}`);
  assert.equal(cachedProfile.metadata.channel_id, TEST_SEC_UID);

  const storyFetch = createStoryFetch();
  const stories = await listProfileStories('creator', { fetchImpl: storyFetch, limit: 2 });
  assert.equal(stories.count, 1);
  assert.equal(stories.entries[0].mediaType, 'story');
  assert.equal(stories.entries[0].url, 'https://www.tiktok.com/@creator/story/3333333333');
  assert.equal(stories.entries[0].directVideoUrl, 'https://cdn.example.test/story.mp4');
  assert.equal(stories.entries[0].duration, 12);

  const cachedStoryFetch = createStoryFetch();
  const cachedStories = await listProfileStories('creator', {
    fetchImpl: cachedStoryFetch,
    limit: 2,
    username: 'creator',
    watch: { author_id: '424242424242', sec_uid: TEST_SEC_UID },
  });
  assert.equal(cachedStories.count, 1);
  assert.equal(cachedStoryFetch.profileRequests, 0);

  const storyRoot = await mkdtemp(path.join(os.tmpdir(), 'tiktok-story-downloads-'));
  const storyDownload = await downloadVideo(stories.entries[0].url, {
    fetchImpl: storyFetch,
    metadata: stories.entries[0],
    downloadDir: storyRoot,
  });
  assert.equal(storyDownload.mediaType, 'story');
  assert.equal(storyDownload.filename, '3333333333.mp4');
  assert.equal(storyDownload.duration, 12);
  assert.equal(storyDownload.timestamp, stories.entries[0].timestamp);
  assert.ok(storyDownload.primaryFile.startsWith(storyRoot));
  assert.equal((await readFile(storyDownload.primaryFile)).toString(), 'fake story video');

  const download = await downloadVideo(url, { ytdlpPath: fake });
  assert.equal(download.metadata.id, '9876543210');
  assert.equal(download.files.length, 1);
  assert.equal(path.basename(download.primaryFile), 'downloaded.mp4');
  assert.ok(download.downloadDir.startsWith(os.tmpdir()));

  const finalRoot = await mkdtemp(path.join(os.tmpdir(), 'tiktok-downloads-'));
  const movedDownload = await downloadVideo(url, { ytdlpPath: fake, downloadDir: finalRoot });
  assert.equal(movedDownload.files.length, 1);
  assert.equal(path.basename(movedDownload.primaryFile), 'downloaded.mp4');
  assert.ok(movedDownload.primaryFile.startsWith(finalRoot));
  assert.equal(path.relative(finalRoot, movedDownload.primaryFile).startsWith('.tmp'), false);
});

test('photo stories are listed, downloaded as images, and remain classified as stories', async () => {
  const storyFetch = createStoryFetch({ photoItems: true });
  const stories = await listProfileStories('creator', { fetchImpl: storyFetch, limit: 2 });
  assert.equal(stories.count, 2);
  const photo = stories.entries.find((entry) => entry.videoId === '4444444444');
  assert.equal(photo.url, 'https://www.tiktok.com/@creator/photo/4444444444');
  assert.equal(photo.mediaType, 'story');
  assert.deepEqual(photo.imageUrls, ['https://cdn.example.test/story-photo.jpg']);

  const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-photo-story-'));
  const result = await downloadVideo(photo.url, {
    metadata: photo,
    fetchImpl: storyFetch,
    ytdlpPath: '/nonexistent/yt-dlp',
    downloadDir: root,
    keepSlideshowImages: true,
  });
  assert.equal(result.mediaType, 'story');
  assert.equal(result.imageCount, 1);
  assert.equal(result.slideshowImagePaths.length, 1);
  assert.equal((await readFile(result.slideshowImagePaths[0])).toString(), 'fake story photo');
  assert.equal((await readFile(result.primaryFile)).subarray(0, 4).toString('hex'), '504b0304');
});

test('flat TikTok playlists use the known creator and post ID for download URLs', async () => {
  const fake = await createFakeYtDlp([
    { id: '7311111111111111111', url: '7311111111111111111' },
    { id: '7322222222222222222', mediaType: 'story', url: '7322222222222222222' },
    { id: '7333333333333333333', webpage_url: 'https://www.tiktok.com/@creator/photo/7333333333333333333?share=1' },
    { id: '7344444444444444444', url: 'https://cdn.example.test/video.mp4' },
  ]);
  const profile = await listProfileVideos('https://www.tiktok.com/@creator', {
    ytdlpPath: fake,
    username: 'creator',
    watch: { sec_uid: TEST_SEC_UID },
  });

  assert.equal(profile.sourceUrl, `tiktokuser:${TEST_SEC_UID}`);
  assert.deepEqual(profile.entries.map((entry) => entry.url), [
    'https://www.tiktok.com/@creator/video/7311111111111111111',
    'https://www.tiktok.com/@creator/story/7322222222222222222',
    'https://www.tiktok.com/@creator/photo/7333333333333333333',
    'https://www.tiktok.com/@creator/video/7344444444444444444',
  ]);
  assert.ok(profile.entries.every((entry) => entry.uploader === 'creator'));

  const directProfile = await listProfileVideos('https://www.tiktok.com/@creator', { ytdlpPath: fake });
  assert.equal(directProfile.entries[0].url, 'https://www.tiktok.com/@creator/video/7311111111111111111');
});

test('playlist URLs prefer a current entry creator and retain yt-dlp URLs without a known creator', async () => {
  const fake = await createFakeYtDlp([
    { id: '7355555555555555555', uploader: 'new_creator', url: '7355555555555555555' },
    { id: '7366666666666666666', url: 'https://www.tiktok.com/t/ZP8GUpGWj/' },
    { id: '7377777777777777777', webpage_url: 'https://www.tiktok.com/@new_creator/video/7377777777777777777?share=1' },
  ]);
  const renamed = await listProfileVideos('https://www.tiktok.com/@old_creator', {
    ytdlpPath: fake,
    username: 'old_creator',
  });
  assert.equal(renamed.entries[0].url, 'https://www.tiktok.com/@new_creator/video/7355555555555555555');
  assert.equal(renamed.entries[2].url, 'https://www.tiktok.com/@new_creator/video/7377777777777777777');

  const withoutCreator = await listProfileVideos('', {
    ytdlpPath: fake,
    watch: { sec_uid: TEST_SEC_UID },
  });
  assert.equal(withoutCreator.entries[1].url, 'https://www.tiktok.com/t/ZP8GUpGWj/');

});

test('canonical downloads extract once and use saved metadata before naming and returning the video', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-single-extraction-'));
  const timestamp = Date.parse('2026-01-02T03:04:05Z') / 1000;
  const savedMetadata = {
    id: '9876543210', title: 'Fresh title', description: 'Fresh description',
    uploader: 'actual.creator', timestamp, duration: 12.5,
    thumbnail: 'https://cdn.example.test/fresh.jpg',
  };
  const fake = await createFakeYtDlp({ savedMetadata });
  try {
    for (const metadata of [
      { id: '9876543210' },
      { id: '9876543210', uploader: 'requested.creator', title: 'Old title', description: 'Old description', duration: 99 },
    ]) {
      const calls = [];
      const result = await downloadVideo('https://www.tiktok.com/@creator/video/9876543210', {
        metadata,
        ytdlpPath: fake,
        downloadDir: root,
        spawnImpl(executable, args, options) {
          calls.push(args);
          return defaultSpawn(executable, args, options);
        },
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].includes('--dump-single-json'), false);
      assert.equal(calls[0].includes('--load-info-json'), false);
      assert.equal(result.videoId, '9876543210');
      assert.equal(result.username, metadata.uploader || savedMetadata.uploader);
      assert.equal(result.title, savedMetadata.title);
      assert.equal(result.description, savedMetadata.description);
      assert.equal(result.duration, savedMetadata.duration);
      assert.equal(result.thumbnailUrl, savedMetadata.thumbnail);
      assert.equal(result.timestamp, timestamp);
      assert.equal(result.metadata.timestamp, timestamp);
      assert.equal(result.downloadDir, path.join(root, result.username, '2026', '01', '02'));
      assert.equal(path.basename(result.primaryFile), 'downloaded.mp4');
      assert.equal(await readFile(result.primaryFile, 'utf8'), 'fake video');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(path.dirname(fake), { recursive: true, force: true });
  }
});

for (const invalid of ['missing', 'corrupt', 'mismatched', 'incomplete']) {
  test(`skeletal download metadata rejects ${invalid} saved metadata without moving caller files`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-invalid-sidecar-'));
    const outputDir = path.join(root, 'caller');
    const savedMetadata = invalid === 'mismatched'
      ? { id: '1111111111', title: 'Another post' }
      : invalid === 'incomplete' ? { id: '9876543210' } : undefined;
    const fake = await createFakeYtDlp({ savedMetadata, sidecarText: invalid === 'corrupt' ? '{invalid' : undefined });
    try {
      await mkdir(outputDir);
      await writeFile(path.join(outputDir, 'keep.txt'), 'caller-owned');
      await writeFile(path.join(outputDir, 'another.info.json'), JSON.stringify({ id: '1111111111', title: 'Another post' }));
      await assert.rejects(downloadVideo('https://www.tiktok.com/@creator/video/9876543210', {
        metadata: { id: '9876543210' },
        ytdlpPath: fake,
        outputDir,
        downloadDir: path.join(root, 'archive'),
      }), { kind: invalid === 'missing' ? 'missing_download_metadata' : 'invalid_download_metadata' });
      assert.equal(await readFile(path.join(outputDir, 'keep.txt'), 'utf8'), 'caller-owned');
      assert.equal(await readFile(path.join(outputDir, 'downloaded.mp4'), 'utf8'), 'fake video');
      await assert.rejects(access(path.join(root, 'archive')), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(path.dirname(fake), { recursive: true, force: true });
    }
  });
}

test('invalid metadata removes downloader-owned staging', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-sidecar-staging-'));
  const fake = await createFakeYtDlp();
  try {
    await assert.rejects(downloadVideo('https://www.tiktok.com/@creator/video/9876543210', {
      metadata: { id: '9876543210' }, ytdlpPath: fake, downloadDir: root,
    }), { kind: 'missing_download_metadata' });
    assert.deepEqual(await readdir(path.join(root, '.tmp')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(path.dirname(fake), { recursive: true, force: true });
  }
});

test('downloads reuse complete metadata with private temporary info and unchanged download options', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ytdlp-info-reuse-'));
  const fake = await createFakeYtDlp();
  const cookiesFile = path.join(dir, 'cookies.txt');
  await writeFile(cookiesFile, '# Netscape HTTP Cookie File\n.tiktok.com\tTRUE\t/\tTRUE\t2147483647\tsessionid\tfixture\n');
  const captured = [];
  try {
    const result = await downloadVideo(COMPLETE_VIDEO_METADATA.webpage_url, {
      metadata: COMPLETE_VIDEO_METADATA,
      ytdlpPath: fake,
      outputDir: path.join(dir, 'output'),
      cookiesFile,
      proxy: 'http://proxy.test:8888',
      format: 'b[vcodec^=h264]',
      ytdlpRetries: 2,
      maxMediaDownloadBytes: 512,
      spawnImpl(executable, args, options) {
        const infoFile = args[args.indexOf('--load-info-json') + 1];
        captured.push({
          args,
          infoFile,
          metadata: JSON.parse(readFileSync(infoFile, 'utf8')),
          fileMode: statSync(infoFile).mode & 0o777,
          dirMode: statSync(path.dirname(infoFile)).mode & 0o777,
        });
        return defaultSpawn(executable, args, options);
      },
    });
    assert.equal(captured.length, 1);
    const { args, infoFile, metadata, fileMode, dirMode } = captured[0];
    assert.deepEqual(metadata, COMPLETE_VIDEO_METADATA);
    assert.equal(fileMode, 0o600);
    assert.equal(dirMode, 0o700);
    assert.ok(args.includes('--abort-on-error'));
    assert.equal(args.includes('--'), false);
    assert.equal(args.includes(COMPLETE_VIDEO_METADATA.webpage_url), false);
    assert.equal(args[args.indexOf('--format') + 1], 'b[vcodec^=h264]');
    assert.equal(args[args.indexOf('--impersonate') + 1], 'chrome');
    assert.equal(args[args.indexOf('--proxy') + 1], 'http://proxy.test:8888');
    assert.equal(args[args.indexOf('--retries') + 1], '2');
    assert.equal(args[args.indexOf('--max-filesize') + 1], '512');
    assert.notEqual(args[args.indexOf('--cookies') + 1], cookiesFile);
    await assert.rejects(access(path.dirname(infoFile)), { code: 'ENOENT' });
    assert.deepEqual(result.files.map((file) => path.basename(file)), ['downloaded.mp4']);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(path.dirname(fake), { recursive: true, force: true });
  }
});

test('incomplete and playlist metadata retain URL extraction', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ytdlp-info-incomplete-'));
  const fake = await createFakeYtDlp();
  try {
    for (const partial of [
      { formats: undefined },
      { formats: [] },
      { formats: [{ format_id: 'missing-url' }] },
      { _type: 'url' },
    ]) {
      await downloadVideo(COMPLETE_VIDEO_METADATA.webpage_url, {
        metadata: { ...COMPLETE_VIDEO_METADATA, ...partial },
        ytdlpPath: fake,
        outputDir: dir,
        spawnImpl(executable, args, options) {
          assert.equal(args.includes('--load-info-json'), false);
          assert.equal(args.at(-1), COMPLETE_VIDEO_METADATA.webpage_url);
          return defaultSpawn(executable, args, options);
        },
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(path.dirname(fake), { recursive: true, force: true });
  }
});

test('temporary download metadata is removed before photo fallback and after subprocess errors', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ytdlp-info-cleanup-'));
  const unsupported = await createUnsupportedYtDlp();
  const denied = await createPrivateYtDlp();
  let fallbackDir;
  try {
    await writeFile(path.join(dir, 'keep.txt'), 'caller-owned');
    for (const ytdlpPath of [unsupported, denied]) {
      let infoFile;
      const photoFetch = createPhotoFetch();
      const operation = downloadVideo(COMPLETE_VIDEO_METADATA.webpage_url, {
        metadata: COMPLETE_VIDEO_METADATA,
        outputDir: dir,
        ytdlpPath,
        spawnImpl(executable, args, options) {
          infoFile = args[args.indexOf('--load-info-json') + 1];
          assert.equal(statSync(infoFile).isFile(), true);
          return defaultSpawn(executable, args, options);
        },
        async fetchImpl(...args) {
          await assert.rejects(access(infoFile), { code: 'ENOENT' });
          return photoFetch(...args);
        },
      });
      if (ytdlpPath === denied) {
        await assert.rejects(operation, { kind: 'access_denied' });
      } else {
        const result = await operation;
        fallbackDir = result.downloadDir;
        assert.equal(result.mediaType, 'slideshow');
        assert.ok(result.files.every((file) => !file.includes('tiktok-download-info-')));
      }
      await assert.rejects(access(path.dirname(infoFile)), { code: 'ENOENT' });
      assert.equal(await readFile(path.join(dir, 'keep.txt'), 'utf8'), 'caller-owned');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (fallbackDir) await rm(fallbackDir, { recursive: true, force: true });
    await rm(path.dirname(unsupported), { recursive: true, force: true });
    await rm(path.dirname(denied), { recursive: true, force: true });
  }
});

test('native yt-dlp reuses info formats and refreshes expired URLs without a custom retry', {
  skip: !process.env.YTDLP_NATIVE_TEST_PATH,
}, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ytdlp-native-info-'));
  const media = Buffer.alloc(4096, 21);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/expired.mp4' || request.url === '/unavailable.mp4') {
      response.writeHead(403);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': media.length });
    response.end(request.method === 'HEAD' ? null : media);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const scenario of ['url-extraction', 'ready', 'expired', 'unavailable']) {
      requests.length = 0;
      const infoJsonFile = path.join(dir, `${scenario}.json`);
      const outputDir = path.join(dir, scenario);
      await writeFile(infoJsonFile, JSON.stringify({
        ...COMPLETE_VIDEO_METADATA,
        extractor: 'generic',
        extractor_key: 'Generic',
        webpage_url: `${origin}/${scenario === 'unavailable' ? 'unavailable' : 'refreshed'}.mp4`,
        formats: [{ ...COMPLETE_VIDEO_METADATA.formats[0], url: `${origin}/${scenario === 'ready' ? 'ready' : 'expired'}.mp4` }],
      }));
      const startedAt = performance.now();
      const args = scenario === 'url-extraction'
        ? buildDownloadArgs(`${origin}/ready.mp4`, { outputDir })
        : buildDownloadArgs('https://www.tiktok.com/@creator/video/9876543210', { infoJsonFile, outputDir });
      const result = await new Promise((resolve, reject) => {
        const child = defaultSpawn(process.env.YTDLP_NATIVE_TEST_PATH, args);
        let stderr = '';
        child.stdout.resume();
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stderr }));
      });
      assert.equal(result.code, scenario === 'unavailable' ? 1 : 0, result.stderr);
      if (scenario !== 'unavailable') {
        const video = (await readdir(outputDir)).find((file) => file.endsWith('.mp4'));
        assert.ok(video);
        assert.deepEqual(await readFile(path.join(outputDir, video)), media);
      }
      if (scenario === 'url-extraction') assert.deepEqual(requests, ['/ready.mp4', '/ready.mp4']);
      else if (scenario === 'ready') assert.deepEqual(requests, ['/ready.mp4']);
      else if (scenario === 'expired') assert.deepEqual(requests, ['/expired.mp4', '/refreshed.mp4', '/refreshed.mp4']);
      else assert.deepEqual(requests, ['/expired.mp4', '/unavailable.mp4']);
      t.diagnostic(`${scenario}: ${requests.length} local requests, exit ${result.code}, ${(performance.now() - startedAt).toFixed(0)} ms.`);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('mixed video and photo Stories list and download as Stories', async (t) => {
  const imageUrls = ['https://cdn.example.test/first.jpg', 'https://cdn.example.test/second.jpg'];
  const imageShapes = {
    imagePost: { imagePost: { images: imageUrls.map((url) => ({ imageURL: { urlList: [url] } })) } },
    legacyImageUrl: { image_post_info: { images: imageUrls.map((url) => ({ image_url: { url_list: [url] } })) } },
    legacyDisplayImage: { image_post_info: { images: imageUrls.map((url) => ({ display_image: { url_list: [url] } })) } },
  };
  const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-photo-stories-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const [shape, images] of Object.entries(imageShapes)) {
    await t.test(shape, async () => {
      const storyFetch = createStoryFetch();
      const photoFetch = createPhotoFetch();
      const fetchImpl = async (url, init) => {
        if (imageUrls.includes(String(url))) return photoFetch(url, init);
        const response = await storyFetch(url, init);
        if (String(url).includes('/api/story/item_list/')) {
          const payload = await response.json();
          payload.itemList.push(
            { id: '4444444444', author: { uniqueId: 'creator' }, ...images },
            { id: '5555555555' },
            { ...images },
          );
          return { ...response, json: async () => payload };
        }
        return response;
      };
      const stories = await listProfileStories('creator', { fetchImpl, limit: 2 });
      assert.equal(stories.count, 2);
      const [video, photo] = stories.entries;
      assert.equal(video.url, 'https://www.tiktok.com/@creator/story/3333333333');
      assert.equal(video.directVideoUrl, 'https://cdn.example.test/story.mp4');
      assert.equal(photo.videoId, '4444444444');
      assert.equal(photo.url, 'https://www.tiktok.com/@creator/photo/4444444444');
      assert.deepEqual(photo.imageUrls, imageUrls);
      assert.equal(photo.mediaType, 'story');
      assert.equal(photo.directVideoUrl, '');

      const download = await downloadVideo(photo.url, {
        metadata: photo,
        fetchImpl,
        downloadDir: path.join(root, shape),
        keepSlideshowImages: true,
      });
      assert.equal(download.mediaType, 'story');
      assert.equal(download.metadata.mediaType, 'story');
      assert.equal(download.imageCount, 2);
      assert.equal(path.extname(download.primaryFile), '.zip');
      const archive = await readFile(download.primaryFile);
      assert.equal(archive.subarray(0, 4).toString('hex'), '504b0304');
      for (const content of ['001.jpg', '002.jpg', 'manifest.json', ...imageUrls.map((url) => `image:${url}`)]) {
        assert.ok(archive.includes(Buffer.from(content)));
      }
      assert.deepEqual(
        await Promise.all(download.slideshowImagePaths.map(async (file) => (await readFile(file)).toString())),
        imageUrls.map((url) => `image:${url}`),
      );
      const infoPath = download.files.find((file) => file.endsWith('.info.json'));
      assert.equal(JSON.parse(await readFile(infoPath, 'utf8')).mediaType, 'story');
    });
  }
});

test('profile listings canonicalize cached secUid URLs and preserve fallback URLs', async (t) => {
  const id = '7688708922114444596';
  const badUrl = `https://www.tiktok.com/@${TEST_SEC_UID}/video/${id}`;
  const cases = [
    { name: 'cached secUid with entry username', entry: { channel: 'creator', webpage_url: badUrl }, username: 'creator' },
    { name: 'options username with bare id', entry: { id: undefined, url: id }, options: { username: 'creator' }, username: 'creator' },
    { name: 'watch username', entry: { url: badUrl }, options: { watch: { username: 'creator', sec_uid: TEST_SEC_UID } }, username: 'creator' },
    { name: 'profile URL username with cached secUid', input: 'https://www.tiktok.com/@creator', entry: { url: id }, username: 'creator' },
    { name: 'plain profile username with cached secUid', input: 'creator', entry: { url: id }, username: 'creator' },
    { name: 'direct profile', input: 'https://www.tiktok.com/@creator', options: { secUid: '' }, entry: { url: id }, username: 'creator' },
    { name: 'photo kind', entry: { uploader: 'creator', webpage_url: badUrl.replace('/video/', '/photo/') }, username: 'creator', kind: 'photo' },
    { name: 'story kind', entry: { uploader: 'creator', mediaType: 'story', url: badUrl }, username: 'creator', kind: 'story' },
    { name: 'renamed entry wins', input: 'https://www.tiktok.com/@old_name', options: { username: 'old_name' }, entry: { uploader: 'new_name', url: badUrl }, username: 'new_name' },
    { name: 'invalid display name skips to channel', entry: { uploader: 'Display Name!', channel: 'creator', url: badUrl }, username: 'creator' },
    { name: 'empty fields skip to entry username', entry: { uploader: '', channel: '', username: 'creator', url: id }, username: 'creator' },
    { name: 'uploader profile URL', entry: { uploader_url: 'https://www.tiktok.com/@creator', url: id }, username: 'creator' },
    { name: 'secUid is not a username', entry: { uploader: TEST_SEC_UID, url: id }, expected: '' },
    { name: 'absolute fallback without username', entry: { webpage_url: `https://www.tiktok.com/t/example/` }, expected: 'https://www.tiktok.com/t/example/' },
    { name: 'lookup string is not a fallback', entry: { url: id }, expected: '' },
    { name: 'nonnumeric id cannot form canonical URL', entry: { id: 'invalid', uploader: 'creator', url: badUrl }, expected: badUrl },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fake = await createFakeYtDlp({ entries: [{ id, ...scenario.entry }] });
      const result = await listProfileVideos(scenario.input ?? '', {
        ytdlpPath: fake,
        secUid: TEST_SEC_UID,
        ...scenario.options,
      });
      const expected = scenario.expected ?? `https://www.tiktok.com/@${scenario.username}/${scenario.kind ?? 'video'}/${id}`;
      assert.equal(result.entries[0].videoUrl, expected);
      assert.equal(result.entries[0].url, expected);
      assert.equal(result.entries[0].webpage_url, expected);
    });
  }
});

test('photo post fallback parses and packages slideshow images', async () => {
  const fake = await createUnsupportedYtDlp();
  const fetchImpl = createPhotoFetch();
  const url = 'https://www.tiktok.com/t/ZP8GUpGWj/';

  const metadata = await fetchVideoMetadata(url, { ytdlpPath: fake, fetchImpl });
  assert.equal(metadata.id, '7640994586499878174');
  assert.equal(metadata.uploader, 'user400567892112');
  assert.equal(metadata.mediaType, 'slideshow');
  assert.equal(metadata.imageCount, 2);

  const finalRoot = await mkdtemp(path.join(os.tmpdir(), 'tiktok-photo-downloads-'));
  const download = await downloadVideo(url, { ytdlpPath: fake, fetchImpl, downloadDir: finalRoot });
  assert.equal(download.mediaType, 'slideshow');
  assert.equal(download.imageCount, 2);
  assert.equal(download.filename, '20260517T224146Z__user400567892112__7640994586499878174.zip');
  assert.equal(path.extname(download.primaryFile), '.zip');
  assert.ok(download.primaryFile.startsWith(finalRoot));

  const archive = await readFile(download.primaryFile);
  assert.equal(archive.subarray(0, 4).toString('hex'), '504b0304');
  assert.ok(archive.includes(Buffer.from('001.jpg')));
  assert.ok(archive.includes(Buffer.from('002.jpg')));
  assert.ok(archive.includes(Buffer.from('manifest.json')));

  const galleryRoot = await mkdtemp(path.join(os.tmpdir(), 'tiktok-photo-gallery-downloads-'));
  const galleryDownload = await downloadVideo(url, {
    ytdlpPath: fake,
    fetchImpl,
    downloadDir: galleryRoot,
    keepSlideshowImages: true,
  });
  assert.deepEqual(
    galleryDownload.slideshowImagePaths.map((filePath) => path.basename(filePath)),
    [
      '20260517T224146Z__user400567892112__7640994586499878174__001.jpg',
      '20260517T224146Z__user400567892112__7640994586499878174__002.jpg',
    ],
  );
});

test('downloadVideo rejects successful yt-dlp runs that only leave non-video artifacts', async () => {
  const fake = await createArtifactOnlyYtDlp();
  const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-incomplete-download-'));
  const sourceUrl = 'https://www.tiktok.com/@creator/video/9876543210';

  await assert.rejects(
    downloadVideo(sourceUrl, {
      ytdlpPath: fake,
      downloadDir: root,
      disablePhotoFallback: true,
      metadata: {
        id: '9876543210',
        uploader: 'creator',
        webpage_url: sourceUrl,
      },
    }),
    (error) => {
      assert.equal(error.kind, 'no_video_file');
      assert.deepEqual(error.files.sort(), [
        '9876543210.description',
        '9876543210.info.json',
        '9876543210.jpg',
        '9876543210.m4a',
      ]);
      return true;
    },
  );

  assert.deepEqual(await readdir(path.join(root, '.tmp')), []);
});

test('downloadVideo converts artifact-only photo posts through the slideshow fallback', async () => {
  const fake = await createArtifactOnlyYtDlp();
  const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-artifact-photo-fallback-'));
  const sourceUrl = 'https://www.tiktok.com/t/ZP8GUpGWj/';

  const result = await downloadVideo(sourceUrl, {
    ytdlpPath: fake,
    fetchImpl: createPhotoFetch(),
    downloadDir: root,
    metadata: {
      id: '7640994586499878174',
      uploader: 'user400567892112',
      webpage_url: sourceUrl,
    },
  });

  assert.equal(result.mediaType, 'slideshow');
  assert.equal(result.timestamp, result.metadata.timestamp);
  assert.ok(result.timestamp > 0);
  assert.equal(path.extname(result.primaryFile), '.zip');
  assert.ok((await readFile(result.primaryFile)).includes(Buffer.from('manifest.json')));
});

test('canonical slideshow fallback preserves publication, soundtrack duration, and the requested creator', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-photo-single-extraction-'));
  const executables = [await createUnsupportedYtDlp(), await createArtifactOnlyYtDlp()];
  try {
    for (const ytdlpPath of executables) {
      let subprocesses = 0;
      const result = await downloadVideo('https://www.tiktok.com/@requested.creator/video/7640994586499878174', {
        metadata: { id: '7640994586499878174', uploader: 'requested.creator', username: 'requested.creator' },
        ytdlpPath,
        downloadDir: root,
        fetchImpl: createPhotoFetch([], { duration: 23 }),
        spawnImpl(executable, args, options) {
          subprocesses += 1;
          assert.equal(args.includes('--dump-single-json'), false);
          return defaultSpawn(executable, args, options);
        },
      });
      assert.equal(subprocesses, 1);
      assert.equal(result.mediaType, 'slideshow');
      assert.equal(result.username, 'requested.creator');
      assert.equal(result.metadata.username, 'requested.creator');
      assert.equal(result.timestamp, 1779057706);
      assert.equal(result.duration, 23);
      assert.equal(result.title, 'I know this much is true');
      assert.equal(result.thumbnailUrl, 'https://cdn.example.test/one.jpeg');
      assert.equal(result.downloadDir, path.join(root, 'requested.creator', '2026', '05', '17'));
      assert.equal(result.filename, '20260517T224146Z__requested.creator__7640994586499878174.zip');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    for (const executable of executables) await rm(path.dirname(executable), { recursive: true, force: true });
  }
});

test('photo fallback ignores leftover video artifacts and preserves caller outputDir', async () => {
  const fake = await createUnsupportedYtDlp();
  const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-photo-fallback-clean-'));
  const outputDir = path.join(root, 'caller-output');
  const sourceUrl = 'https://www.tiktok.com/t/ZP8GUpGWj/';
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'keep-me.txt'), 'caller owned');
  await writeFile(path.join(outputDir, 'leftover.mp4'), 'stale video');

  const result = await downloadVideo(sourceUrl, {
    ytdlpPath: fake,
    fetchImpl: createPhotoFetch(),
    outputDir,
    metadata: {
      id: '7640994586499878174',
      uploader: 'user400567892112',
      webpage_url: sourceUrl,
    },
  });

  assert.equal(result.mediaType, 'slideshow');
  assert.equal(path.extname(result.primaryFile), '.zip');
  assert.equal(await readFile(path.join(outputDir, 'keep-me.txt'), 'utf8'), 'caller owned');
  assert.equal(await readFile(path.join(outputDir, 'leftover.mp4'), 'utf8'), 'stale video');
  assert.notEqual(path.dirname(result.primaryFile), outputDir);
});

test('slideshow fallback streams image bodies and rejects configured size/count limits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-photo-limits-'));
  const metadata = {
    id: 'streamed-photo',
    title: 'streamed photo',
    uploader: 'creator',
    mediaType: 'slideshow',
    imageUrls: ['https://cdn.example.test/streamed.jpg'],
  };
  const image = Buffer.from('streamed image bytes');
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    url: 'https://cdn.example.test/streamed.jpg',
    headers: { get: (name) => name === 'content-type' ? 'image/jpeg' : null },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(image.subarray(0, 6));
        controller.enqueue(image.subarray(6));
        controller.close();
      },
    }),
  });
  const result = await downloadVideo('https://www.tiktok.com/@creator/photo/streamed-photo', {
    metadata,
    fetchImpl,
    downloadDir: root,
    maxSlideshowItemBytes: 1024,
    maxSlideshowTotalBytes: 1024,
  });
  assert.equal(result.mediaType, 'slideshow');
  assert.ok((await readFile(result.primaryFile)).includes(Buffer.from('streamed image bytes')));

  await assert.rejects(
    downloadVideo('https://www.tiktok.com/@creator/photo/too-many', {
      metadata: { ...metadata, imageUrls: Array.from({ length: 3 }, (_, index) => `https://cdn.example.test/${index}.jpg`) },
      fetchImpl,
      downloadDir: root,
      maxSlideshowImages: 2,
    }),
    /exceeding the configured limit/i,
  );
  const tempEntries = await readdir(path.join(root, '.tmp')).catch(() => []);
  assert.deepEqual(tempEntries, []);
});

test('photo metadata streaming enforces its byte limit before parsing', async () => {
  const oversized = Buffer.from('<html>this metadata is too large</html>');
  await assert.rejects(
    fetchPhotoPostMetadata('https://www.tiktok.com/@creator/photo/streamed-metadata', {
      maxPhotoMetadataBytes: 8,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'https://www.tiktok.com/@creator/photo/streamed-metadata',
        headers: { get: () => null },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(oversized.subarray(0, 8));
            controller.enqueue(oversized.subarray(8));
            controller.close();
          },
        }),
      }),
    }),
    /size limit/i,
  );
});

test('story profile and JSON responses enforce streamed byte limits and timeouts', async () => {
  const oversized = Buffer.from('<html>oversized story profile metadata</html>');
  await assert.rejects(
    listProfileStories('creator', {
      maxStoryMetadataBytes: 8,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'https://www.tiktok.com/@creator',
        headers: { get: () => null },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(oversized);
            controller.close();
          },
        }),
      }),
    }),
    /size limit/i,
  );

  await assert.rejects(
    listProfileStories('creator', {
      fetchTimeoutSeconds: 1,
      username: 'creator',
      watch: { author_id: '424242424242', sec_uid: TEST_SEC_UID, has_story: 1 },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'https://www.tiktok.com/api/story/item_list/',
        headers: { get: () => null },
        body: new ReadableStream({ start() {} }),
      }),
    }),
    (error) => error?.kind === 'fetch_timeout',
  );

  const oversizedJson = Buffer.from(JSON.stringify({ statusCode: 0, itemList: [], padding: 'x'.repeat(64) }));
  await assert.rejects(
    listProfileStories('creator', {
      maxStoryMetadataBytes: 16,
      username: 'creator',
      watch: { author_id: '424242424242', sec_uid: TEST_SEC_UID, has_story: 1 },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'https://www.tiktok.com/api/story/item_list/',
        headers: { get: () => null },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(oversizedJson);
            controller.close();
          },
        }),
      }),
    }),
    /size limit/i,
  );
});

test('listProfileStories refreshes cached no-story profiles before hitting the story API', async () => {
  const storyFetch = createStoryFetch({ userStoryStatus: 0, hasItems: false });
  const stories = await listProfileStories('creator', {
    fetchImpl: storyFetch,
    limit: 2,
    username: 'creator',
    watch: { author_id: '424242424242', sec_uid: TEST_SEC_UID, has_story: 0 },
  });

  assert.equal(stories.count, 0);
  assert.equal(storyFetch.profileRequests, 1);
  assert.equal(storyFetch.apiRequests, 0);
  assert.equal(stories.metadata.hasStory, false);
});

test('cookie-backed private failures stay access_denied and do not spawn a retryable path', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-private-cookies-'));
  const cookiesFile = path.join(dir, 'tiktok.txt');
  await writeFile(cookiesFile, [
    '# Netscape HTTP Cookie File',
    '.tiktok.com\tTRUE\t/\tTRUE\t2147483647\tsessionid\ttest-session',
  ].join('\n'));
  const fake = await createPrivateYtDlp();

  await assert.rejects(
    fetchVideoMetadata('https://www.tiktok.com/@creator/video/123', {
      ytdlpPath: fake,
      ytdlpCookiesFile: cookiesFile,
      disablePhotoFallback: true,
    }),
    (error) => {
      assert.equal(error.kind, 'access_denied');
      assert.equal(error.retryable, false);
      assert.match(error.message, /cookie session cannot access/i);
      return true;
    },
  );

  await assert.rejects(
    fetchVideoMetadata('https://www.tiktok.com/@creator/video/123', {
      ytdlpPath: fake,
      disablePhotoFallback: true,
    }),
    (error) => {
      assert.equal(error.kind, 'access_denied');
      assert.equal(error.retryable, false);
      assert.match(error.message, /not publicly accessible/);
      return true;
    },
  );
});

test('parsePhotoPostMetadata rejects HTML without image data', () => {
  assert.throws(
    () => parsePhotoPostMetadata('<html></html>', 'https://www.tiktok.com/@user/photo/1'),
    /rehydration data/,
  );
});

test('configured cookies are required to exist and are sent on photo/story HTTP fallbacks', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-cookies-session-'));
  const cookiesFile = path.join(dir, 'tiktok.txt');
  await writeFile(cookiesFile, [
    '# Netscape HTTP Cookie File',
    '.tiktok.com\tTRUE\t/\tTRUE\t2147483647\tsessionid\ttest-session',
    '.tiktok.com\tTRUE\t/\tTRUE\t2147483647\tsid_tt\ttest-sid',
  ].join('\n'));

  let spawnCalls = 0;
  await assert.rejects(
    fetchVideoMetadata('https://www.tiktok.com/@creator/video/123', {
      ytdlpCookiesFile: path.join(dir, 'missing.txt'),
      spawnImpl: () => {
        spawnCalls += 1;
        throw new Error('must not spawn');
      },
    }),
    (error) => {
      assert.equal(error.kind, 'cookies_unreadable');
      assert.equal(error.retryable, false);
      assert.match(error.message, /missing or unreadable/);
      return true;
    },
  );
  assert.equal(spawnCalls, 0);

  const emptyFile = path.join(dir, 'empty.txt');
  await writeFile(emptyFile, '# Netscape HTTP Cookie File\n');
  await assert.rejects(
    fetchPhotoPostMetadata('https://www.tiktok.com/@creator/photo/1', {
      ytdlpCookiesFile: emptyFile,
      fetchImpl: async () => {
        throw new Error('must not fetch anonymously');
      },
    }),
    (error) => error.kind === 'cookies_unreadable' && /did not contain any Netscape cookies/.test(error.message),
  );

  const photoCalls = [];
  const photoFetch = createPhotoFetch(photoCalls);
  await fetchPhotoPostMetadata('https://www.tiktok.com/@creator/photo/1', {
    ytdlpCookiesFile: cookiesFile,
    ytdlpProxy: 'http://proxy.test:8888',
    fetchImpl: photoFetch,
  });
  assert.equal(photoCalls.length, 1);
  assert.match(headerValue(photoCalls[0].init.headers, 'cookie'), /sessionid=test-session/);
  assert.ok(photoCalls[0].init.dispatcher);

  const anonymousPhotoCalls = [];
  await fetchPhotoPostMetadata('https://www.tiktok.com/@creator/photo/1', {
    fetchImpl: createPhotoFetch(anonymousPhotoCalls),
  });
  assert.equal(headerValue(anonymousPhotoCalls[0].init.headers, 'cookie'), '');
  assert.equal(anonymousPhotoCalls[0].init.dispatcher, undefined);

  const storyFetch = createStoryFetch();
  const stories = await listProfileStories('creator', {
    fetchImpl: storyFetch,
    limit: 2,
    ytdlpCookiesFile: cookiesFile,
    ytdlpProxy: 'http://proxy.test:8888',
  });
  assert.equal(stories.count, 1);
  assert.ok(storyFetch.calls.length >= 2);
  assert.ok(storyFetch.calls.filter((call) => new URL(String(call.url)).hostname.endsWith('tiktok.com'))
    .every((call) => headerValue(call.init.headers, 'cookie').includes('sessionid=test-session')));
  assert.ok(storyFetch.calls.every((call) => call.init.dispatcher));

  const storyRoot = await mkdtemp(path.join(os.tmpdir(), 'tiktok-story-cookie-downloads-'));
  await downloadVideo(stories.entries[0].url, {
    fetchImpl: storyFetch,
    metadata: stories.entries[0],
    downloadDir: storyRoot,
    ytdlpCookiesFile: cookiesFile,
  });
  const cdnCall = storyFetch.calls.find((call) => String(call.url).includes('cdn.example.test/story.mp4'));
  assert.ok(cdnCall);
  assert.equal(headerValue(cdnCall.init.headers, 'cookie'), '');

  const imageCalls = [];
  const photoRoot = await mkdtemp(path.join(os.tmpdir(), 'tiktok-photo-cookie-downloads-'));
  await downloadVideo('https://www.tiktok.com/@creator/photo/streamed-photo', {
    metadata: {
      id: 'streamed-photo',
      title: 'streamed photo',
      uploader: 'creator',
      mediaType: 'slideshow',
      imageUrls: ['https://cdn.example.test/one.jpeg'],
    },
    fetchImpl: createPhotoFetch(imageCalls),
    downloadDir: photoRoot,
    ytdlpCookiesFile: cookiesFile,
  });
  assert.ok(imageCalls.some((call) => /\.jpe?g/.test(String(call.url))));
  assert.ok(imageCalls.every((call) => headerValue(call.init.headers, 'cookie') === ''));
});

test('yt-dlp gets --impersonate chrome and a writable cookies copy, not the mounted source file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-cookies-durable-'));
  const original = path.join(dir, 'tiktok.txt');
  const originalText = [
    '# Netscape HTTP Cookie File',
    '.tiktok.com\tTRUE\t/\tTRUE\t2147483647\tsessionid\ttest-session',
    '.tiktok.com\tTRUE\t/\tTRUE\t2147483647\tttwid\ttest-ttwid',
    '.tiktok.com\tTRUE\t/\tTRUE\t2147483647\tmsToken\ttest-mstoken',
  ].join('\n');
  await writeFile(original, originalText, { mode: 0o444 });

  const captured = [];
  const fake = await createCookieRewritingYtDlp();
  await fetchVideoMetadata('https://www.tiktok.com/@creator/video/9876543210', {
    ytdlpPath: fake,
    ytdlpCookiesFile: original,
    ytdlpProxy: 'http://proxy.test:8888',
    spawnImpl: (executable, args, spawnOptions) => {
      captured.push({ args, env: spawnOptions?.env });
      return defaultSpawn(executable, args, spawnOptions);
    },
  });

  assert.equal(await readFile(original, 'utf8'), originalText);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].args[captured[0].args.indexOf('--impersonate') + 1], 'chrome');
  const cookiesPath = captured[0].args[captured[0].args.indexOf('--cookies') + 1];
  assert.notEqual(cookiesPath, original);
  assert.match(cookiesPath, /tiktok-cookies-copy-/);
  assert.equal(captured[0].env.http_proxy, 'http://proxy.test:8888');
  assert.equal(captured[0].env.HTTPS_PROXY, 'http://proxy.test:8888');
});

async function createFakeYtDlp(input = {}) {
  const { savedMetadata, sidecarText, entries } = Array.isArray(input) ? { entries: input } : (input ?? {});
  const playlistEntries = entries ?? null;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fake-ytdlp-'));
  const scriptPath = path.join(dir, 'yt-dlp');
  const metadataText = sidecarText ?? (savedMetadata === undefined ? undefined : JSON.stringify(savedMetadata));
  const sidecarWrite = metadataText === undefined ? ''
    : `fs.writeFileSync(path.join(downloadDir, '9876543210.info.json'), ${JSON.stringify(metadataText)});`;
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valuesAfter = (flag) => args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : []);

if (has('--dump-single-json')) {
  const sourceUrl = args[args.length - 1] || '';
  if (sourceUrl.includes('/story')) {
    process.stdout.write(JSON.stringify({
      _type: 'playlist',
      id: 'creator-stories',
      title: 'Creator stories',
      entries: [
        { id: '3333333333', title: 'Story', url: '3333333333', duration: 12 },
      ],
    }));
    process.exit(0);
  }

  if (has('--flat-playlist') && ${JSON.stringify(entries) ?? 'null'}) {
    process.stdout.write(JSON.stringify({ entries: ${JSON.stringify(entries) ?? 'null'} }));
    process.exit(0);
  }

  if (has('--flat-playlist')) {
    const isSecUidProfile = sourceUrl.startsWith('tiktokuser:');
    const secUid = isSecUidProfile ? sourceUrl.slice('tiktokuser:'.length) : 'creator';
    const fixtureEntries = ${JSON.stringify(playlistEntries)};
    process.stdout.write(JSON.stringify({
      _type: 'playlist',
      id: secUid,
      title: 'Creator uploads',
      entries: fixtureEntries ?? [
        { id: '111', title: 'First', uploader: 'creator', uploader_id: '424242424242', channel_id: isSecUidProfile ? secUid : '${TEST_SEC_UID}', webpage_url: 'https://www.tiktok.com/@creator/video/111' },
        { id: '222', title: 'Second', uploader: 'creator', uploader_id: '424242424242', channel_id: isSecUidProfile ? secUid : '${TEST_SEC_UID}', webpage_url: 'https://www.tiktok.com/@creator/video/222' },
      ],
    }));
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({
    id: '9876543210',
    title: 'A video',
    uploader: 'creator',
    webpage_url: 'https://www.tiktok.com/@creator/video/9876543210',
  }));
  process.exit(0);
}

const pathsArgs = valuesAfter('--paths');
const pathsArg = pathsArgs.find((entry) => entry.startsWith('home:')) ?? pathsArgs.find((entry) => entry.startsWith('temp:')) ?? '';
const downloadDir = pathsArg.includes(':') ? pathsArg.slice(pathsArg.indexOf(':') + 1) : pathsArg;
if (!downloadDir) {
  process.stderr.write('missing download dir');
  process.exit(2);
}

fs.mkdirSync(downloadDir, { recursive: true });
const outputPath = path.join(downloadDir, 'downloaded.mp4');
fs.writeFileSync(outputPath, 'fake video');
${sidecarWrite}
process.stdout.write(outputPath + '\\n');
process.exit(0);
`;

  await writeFile(scriptPath, script, { mode: 0o755 });
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function createCookieRewritingYtDlp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fake-ytdlp-cookies-rewrite-'));
  const scriptPath = path.join(dir, 'yt-dlp');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const cookies = args[args.indexOf('--cookies') + 1];
if (!cookies) {
  process.stderr.write('missing cookies');
  process.exit(2);
}
fs.writeFileSync(cookies, '# Netscape HTTP Cookie File\\n# yt-dlp clobbered sessionid\\n');
process.stdout.write(JSON.stringify({
  id: '9876543210',
  title: 'A video',
  uploader: 'creator',
  webpage_url: 'https://www.tiktok.com/@creator/video/9876543210',
}));
process.exit(0);
`;

  await writeFile(scriptPath, script, { mode: 0o755 });
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function createUnsupportedYtDlp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fake-ytdlp-unsupported-'));
  const scriptPath = path.join(dir, 'yt-dlp');
  const script = `#!/usr/bin/env node
process.stderr.write('ERROR: Unsupported URL: https://www.tiktok.com/@user400567892112/photo/7640994586499878174\\n');
process.exit(1);
`;

  await writeFile(scriptPath, script, { mode: 0o755 });
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function createPrivateYtDlp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fake-ytdlp-private-'));
  const scriptPath = path.join(dir, 'yt-dlp');
  const script = `#!/usr/bin/env node
process.stderr.write("ERROR: This user’s account is private. Log in or use --cookies.\\n");
process.exit(1);
`;

  await writeFile(scriptPath, script, { mode: 0o755 });
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function createArtifactOnlyYtDlp({ seedVideo = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fake-ytdlp-artifacts-'));
  const scriptPath = path.join(dir, 'yt-dlp');
  const seedVideoLine = seedVideo
    ? "fs.writeFileSync(path.join(outputDir, 'leftover.mp4'), 'stale video');"
    : '';
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const paths = args.flatMap((arg, index) => arg === '--paths' ? [args[index + 1]] : []);
const home = paths.find((entry) => entry.startsWith('home:')) || paths.find((entry) => entry.startsWith('temp:')) || '';
const outputDir = home.slice(home.indexOf(':') + 1);
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, '9876543210.jpg'), 'thumbnail');
fs.writeFileSync(path.join(outputDir, '9876543210.m4a'), 'audio');
fs.writeFileSync(path.join(outputDir, '9876543210.info.json'), '{}');
fs.writeFileSync(path.join(outputDir, '9876543210.description'), 'description');
${seedVideoLine}
process.exit(0);
`;

  await writeFile(scriptPath, script, { mode: 0o755 });
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

function headerValue(headers, name) {
  if (!headers) return '';
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : '';
}

function createPhotoFetch(calls = [], { duration = 0 } = {}) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const textUrl = String(url);
    if (/\.jpe?g/.test(textUrl)) {
      const image = Buffer.from(`image:${textUrl}`);
      return {
        ok: true,
        status: 200,
        url: textUrl,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength),
      };
    }
    return {
      ok: true,
      status: 200,
      url: 'https://www.tiktok.com/@user400567892112/photo/7640994586499878174',
      text: async () => makePhotoHtml({ duration }),
    };
  };
}

function createStoryFetch({ userStoryStatus = 1, hasItems = true, photoItems = false } = {}) {
  const fetchImpl = async (url, init = {}) => {
    const textUrl = String(url);
    fetchImpl.calls.push({ url: textUrl, init });
    if (textUrl.includes('/api/story/item_list/')) {
      fetchImpl.apiRequests += 1;
      const parsed = new URL(textUrl);
      assert.equal(parsed.searchParams.get('authorId'), '424242424242');
      assert.equal(parsed.searchParams.get('count'), '2');
      const itemList = hasItems
        ? [
            {
              id: '3333333333',
              desc: 'Story',
              createTime: '1780000000',
              author: {
                uniqueId: 'creator',
              },
              story: {
                ExpiredAt: 1780086400000,
              },
              video: {
                id: '3333333333',
                duration: 12,
                cover: 'https://cdn.example.test/story.jpg',
                PlayAddrStruct: {
                  DataSize: 16,
                  UrlList: ['https://cdn.example.test/story.mp4'],
                },
              },
            },
            ...(photoItems ? [{
              id: '4444444444',
              desc: 'Photo Story',
              author: { uniqueId: 'creator' },
              imagePost: {
                images: [{ imageURL: { urlList: ['https://cdn.example.test/story-photo.jpg'] } }],
              },
            }] : []),
          ]
        : [];
      return {
        ok: true,
        status: 200,
        url: textUrl,
        json: async () => ({
          statusCode: 0,
          TotalCount: itemList.length,
          itemList,
        }),
      };
    }

    if (textUrl === 'https://cdn.example.test/story.mp4') {
      const video = Buffer.from('fake story video');
      return {
        ok: true,
        status: 200,
        url: textUrl,
        headers: { get: () => 'video/mp4' },
        arrayBuffer: async () => video.buffer.slice(video.byteOffset, video.byteOffset + video.byteLength),
      };
    }

    if (textUrl === 'https://cdn.example.test/story-photo.jpg') {
      const image = Buffer.from('fake story photo');
      return {
        ok: true,
        status: 200,
        url: textUrl,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength),
      };
    }

    if (textUrl.includes('www.tiktok.com/@creator')) {
      fetchImpl.profileRequests += 1;
    }
    return {
      ok: true,
      status: 200,
      url: 'https://www.tiktok.com/@creator',
      text: async () => makeStoryProfileHtml({ userStoryStatus }),
    };
  };
  fetchImpl.profileRequests = 0;
  fetchImpl.apiRequests = 0;
  fetchImpl.calls = [];
  return fetchImpl;
}

function makeStoryProfileHtml({ userStoryStatus = 1 } = {}) {
  const data = {
    __DEFAULT_SCOPE__: {
      'webapp.user-detail': {
        userInfo: {
          user: {
            id: '424242424242',
            uniqueId: 'creator',
            secUid: TEST_SEC_UID,
            UserStoryStatus: userStoryStatus,
          },
        },
      },
    },
  };
  return `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script></html>`;
}

function makePhotoHtml({ duration = 0 } = {}) {
  const data = {
    __DEFAULT_SCOPE__: {
      'webapp.reflow.video.detail': {
        itemInfo: {
          itemStruct: {
            id: '7640994586499878174',
            desc: 'I know this much is true',
            createTime: '1779057706',
            music: { duration },
            author: {
              uniqueId: 'user400567892112',
              nickname: 'creator',
            },
            imagePost: {
              images: [
                {
                  imageURL: {
                    urlList: ['https://cdn.example.test/one.jpeg'],
                  },
                  imageWidth: 100,
                  imageHeight: 100,
                },
                {
                  imageURL: {
                    urlList: ['https://cdn.example.test/two.jpeg'],
                  },
                  imageWidth: 200,
                  imageHeight: 200,
                },
              ],
            },
          },
        },
      },
    },
  };
  return `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script></html>`;
}
