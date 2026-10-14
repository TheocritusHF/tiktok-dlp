import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { instagramLayout, archiveInstagramDownload, removeUnpersistedInstagramFiles } from '../src/platforms/instagramLayout.js';
import { createHash } from 'node:crypto';
const hashFile = async (filename) => createHash('sha256').update(await readFile(filename)).digest('hex');

const post = { platform: 'instagram', remoteId: 'story_1234567890123456789', creator: { handle: 'fixture_creator' }, mediaType: 'story', publishedAt: '2026-10-13T23:10:12Z' };
async function fixture(t, count = 1, otherPost = post) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ig-layout-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'downloads'), staging = path.join(temp, 'staging');
  await mkdir(staging);
  const assets = [];
  for (let i = 0; i < count; i++) {
    const filename = count > 1 ? `asset_${i + 1}.jpg` : 'asset_001.mp4';
    const filePath = path.join(staging, filename); await writeFile(filePath, `media ${i}`);
    assets.push({ path: filePath, filename, kind: count > 1 ? 'image' : 'video', position: i + 1, width: 1080, height: 1920, sourceUrl: 'https://secret.invalid/signed-token' });
  }
  return { temp, root, downloaded: { post: otherPost, outputDir: staging, assets } };
}
const zip = undefined;

test('Story filename carries date, creator and identity directly in the shared UTC day directory', () => {
  const l = instagramLayout(post, '/archive', [{ filename: 'asset_001.mp4' }]);
  assert.equal(l.directory, '/archive/instagram/fixture_creator/Stories/2026/10/13');
  assert.equal(l.filenames[0], '20261013T231012Z__fixture_creator__story_1234567890123456789.mp4');
});
test('Posts and carousel assets have chronological, unique, ordered names', () => {
  const l = instagramLayout({ ...post, remoteId: 'AbCdE', mediaType: 'image' }, '/archive', [{ filename: 'a.jpg' }, { filename: 'b.MP4' }]);
  assert.match(l.directory, /\/Posts\/2026\/10\/13$/);
  assert.match(l.filenames[0], /__post_AbCdE__001.jpg$/);
  assert.match(l.filenames[1], /__post_AbCdE__002.mp4$/);
  assert.match(l.bundlePath, /\/_bundles\/.+\.zip$/);
});
test('Highlights have their own daily grouping', () => {
  assert.match(instagramLayout({ ...post, remoteId: 'highlight_123', mediaType: 'highlight' }, '/archive', [{ filename: 'a.mp4' }]).directory, /\/Highlights\//);
});
test('Invalid identity, extension and date cannot create paths', () => {
  for (const change of [{ remoteId: '../other' }, { creator: { handle: '..' } }, { publishedAt: 'invalid' }, { platform: 'tiktok' }]) {
    assert.throws(() => instagramLayout({ ...post, ...change }, '/archive', [{ filename: 'a.mp4' }]));
  }
  assert.throws(() => instagramLayout(post, '/archive', [{ filename: 'asset' }]));
});
test('Single Story preserves exact media bytes and source-quality metadata', async t => {
  const f = await fixture(t); const oldHash = await hashFile(f.downloaded.assets[0].path);
  const result = await archiveInstagramDownload(f.downloaded, { downloadDir: f.root });
  assert.equal(await hashFile(result.filePath), oldHash);
  assert.equal(result.assets[0].width, 1080); assert.equal(result.assets[0].height, 1920);
  assert.equal(result.sizeBytes, 7); assert.equal(result.ownedArchiveFiles.length, 1);
  assert.deepEqual(await readdir(result.outputDir), [result.filename]);
});
test('Two Stories on a day share one folder without asset_001 names', async t => {
  const f = await fixture(t); const first = await archiveInstagramDownload(f.downloaded, { downloadDir: f.root });
  const secondStaging = path.join(f.temp, 'second'); await mkdir(secondStaging); const source = path.join(secondStaging, 'asset_001.mp4'); await writeFile(source, 'second');
  const second = await archiveInstagramDownload({ post: { ...post, remoteId: 'story_222' }, outputDir: secondStaging, assets: [{ path: source }] }, { downloadDir: f.root });
  assert.equal(first.outputDir, second.outputDir); assert.equal((await readdir(first.outputDir)).length, 2);
});
test('Carousel bundle is outside the daily media list and manifest excludes signed source URLs', async t => {
  const f = await fixture(t, 2, { ...post, remoteId: 'Carousel', mediaType: 'image' });
  const result = await archiveInstagramDownload(f.downloaded, { downloadDir: f.root, createZip: zip });
  assert.equal(path.dirname(result.filePath), path.join(result.outputDir, '_bundles'));
  assert.equal(result.ownedArchiveFiles.length, 3);
  assert.equal((await readdir(result.outputDir)).filter(n => n.endsWith('.jpg')).length, 2);
  // ZIP uses stored entries; strings are visible with both the real and injected writer.
  const bytes = await readFile(result.filePath); assert.equal(bytes.includes(Buffer.from('signed-token')), false);
  assert.equal(bytes.includes(Buffer.from(result.assets[0].filename)), true);
});
test('Duplicate download uses a suffix and never overwrites existing files', async t => {
  const f = await fixture(t); const first = await archiveInstagramDownload(f.downloaded, { downloadDir: f.root });
  const staging = path.join(f.temp, 'again'); await mkdir(staging); const file = path.join(staging, 'asset.mp4'); await writeFile(file, 'different');
  const second = await archiveInstagramDownload({ post, outputDir: staging, assets: [{ path: file }] }, { downloadDir: f.root });
  assert.notEqual(first.filePath, second.filePath); assert.match(second.filename, /__copy_[a-f0-9]{12}\.mp4$/);
  assert.equal((await readFile(first.filePath)).toString(), 'media 0');
});
test('Persistence failure cleanup removes only owned files and leaves another Story intact', async t => {
  const f = await fixture(t, 2); const result = await archiveInstagramDownload(f.downloaded, { downloadDir: f.root, createZip: zip });
  const unrelated = path.join(result.outputDir, 'other-story.mp4'); await writeFile(unrelated, 'keep');
  await removeUnpersistedInstagramFiles(f.root, result);
  assert.equal((await readFile(unrelated)).toString(), 'keep');
  for (const owned of result.ownedArchiveFiles) await assert.rejects(lstat(owned), { code: 'ENOENT' });
});
test('Cleanup rejects any owned path outside its daily directory before deleting files', async t => {
  const f = await fixture(t); const result = await archiveInstagramDownload(f.downloaded, { downloadDir: f.root });
  await assert.rejects(removeUnpersistedInstagramFiles(f.root, { ...result, ownedArchiveFiles: [...result.ownedArchiveFiles, path.join(f.temp, 'other')] }));
  assert.equal((await readFile(result.filePath)).toString(), 'media 0');
});
test('Failed ZIP creation leaves already archived siblings untouched', async t => {
  const f = await fixture(t, 2); const layout = instagramLayout(post, f.root, f.downloaded.assets);
  await mkdir(layout.directory, { recursive: true }); const sibling = path.join(layout.directory, 'sibling.mp4'); await writeFile(sibling, 'keep');
  await assert.rejects(archiveInstagramDownload(f.downloaded, { downloadDir: f.root, createZip: async () => { throw new Error('zip failed'); } }));
  assert.equal((await readFile(sibling)).toString(), 'keep'); assert.equal((await readFile(f.downloaded.assets[0].path)).toString(), 'media 0');
});
test('Staging asset traversal and archive symlinks are rejected', async t => {
  const f = await fixture(t); const outside = path.join(f.temp, 'outside.mp4'); await writeFile(outside, 'keep');
  await assert.rejects(archiveInstagramDownload({ ...f.downloaded, assets: [{ path: outside }] }, { downloadDir: f.root }));
  await mkdir(f.root); await symlink(f.temp, path.join(f.root, 'instagram'), 'dir');
  await assert.rejects(archiveInstagramDownload(f.downloaded, { downloadDir: f.root }));
});


test('Existing retention cleanup removes only a selected daily post and its package', async t => {
  const { removeStoredFiles } = await import('../src/cleanup/downloads.js');
  const f = await fixture(t, 2); const result = await archiveInstagramDownload(f.downloaded, { downloadDir: f.root, createZip: zip });
  const keep = path.join(result.outputDir, '20261013T231013Z__fixture_creator__story_999.mp4'); await writeFile(keep, 'keep');
  const removal = await removeStoredFiles([{ id: 1, video_id: post.remoteId, path: result.filePath,
    asset_paths: result.assets.map(a => a.path) }], { downloadDir: f.root });
  assert.equal(removal.failed.length, 0); assert.equal((await readFile(keep)).toString(), 'keep');
  for (const file of result.ownedArchiveFiles) await assert.rejects(lstat(file), { code: 'ENOENT' });
});

test('Parallel downloads of the same Story get distinct files without corrupting either', async t => {
  const f = await fixture(t); const staging2 = path.join(f.temp, 'parallel'); await mkdir(staging2);
  const source = path.join(staging2, 'asset.mp4'); await writeFile(source, 'parallel');
  const results = await Promise.all([archiveInstagramDownload(f.downloaded, { downloadDir: f.root }),
    archiveInstagramDownload({ post, outputDir: staging2, assets: [{ path: source }] }, { downloadDir: f.root })]);
  assert.notEqual(results[0].filePath, results[1].filePath);
  assert.deepEqual(await Promise.all(results.map(async r => (await readFile(r.filePath)).toString())), ['media 0', 'parallel']);
});

test('Running DownloadService persists daily paths and keeps measured 1080p metadata', async t => {
  const { DownloadService } = await import('../src/download/service.js'); const f = await fixture(t);
  let saved;
  const adapter = { platform: 'instagram', capabilities: { archiveOwnedStaging: true },
    canonicalizeUrl: url => url.href, parsePostReference: () => ({ remoteId: post.remoteId, canonicalUrl: 'https://www.instagram.com/stories/fixture_creator/1234567890123456789/' }),
    download: async () => ({ ...f.downloaded, duration: 11.1, width: 1080, height: 1920 }) };
  const service = new DownloadService({ config: { downloadDir: f.root },
    platformRegistry: { forUrl: url => ({ adapter, url: new URL(url) }) },
    store: { createJob: () => 1, updateJob: () => {}, getLatestFileByPost: () => null,
      createFileWithMedia: value => { saved = value; return { fileId: 1 }; } } });
  const result = await service.request('https://www.instagram.com/stories/fixture_creator/1234567890123456789/',
    { createDelivery: false, metadata: { id: post.remoteId, width: 720, height: 1280 } });
  assert.equal(saved.file.filePath, result.filePath); assert.equal(saved.media.assets[0].path, result.filePath);
  assert.equal(result.width, 1080); assert.equal(result.height, 1920); assert.equal(result.duration, 11.1);
  assert.match(result.filename, /__story_1234567890123456789.mp4$/);
});

test('Actual persistence-error handling never deletes the shared daily folder', async t => {
  const { DownloadService } = await import('../src/download/service.js'); const f = await fixture(t);
  const layout = instagramLayout(post, f.root, f.downloaded.assets); await mkdir(layout.directory, { recursive: true });
  const sibling = path.join(layout.directory, 'other_story.mp4'); await writeFile(sibling, 'keep');
  const adapter = { platform: 'instagram', capabilities: { archiveOwnedStaging: true }, canonicalizeUrl: url => url.href,
    parsePostReference: () => ({ remoteId: post.remoteId, canonicalUrl: 'https://www.instagram.com/stories/fixture_creator/1234567890123456789/' }), download: async () => f.downloaded };
  const service = new DownloadService({ config: { downloadDir: f.root }, logger: { warn: () => {} },
    platformRegistry: { forUrl: url => ({ adapter, url: new URL(url) }) },
    store: { createJob: () => 1, updateJob: () => {}, getLatestFileByPost: () => null,
      createFileWithMedia: () => { throw new Error('fixture persistence failed'); } } });
  await assert.rejects(service.request('https://www.instagram.com/stories/fixture_creator/1234567890123456789/',
    { createDelivery: false, metadata: { id: post.remoteId } }), /fixture persistence failed/);
  assert.equal((await readFile(sibling)).toString(), 'keep'); assert.deepEqual(await readdir(layout.directory), ['other_story.mp4']);
});

test('Legacy layout stays available, and X/TikTok keep per-item archive directories', async t => {
  const { archivePlatformDownload } = await import('../src/platforms/archive.js');
  for (const platform of ['instagram', 'x', 'tiktok']) {
    const f = await fixture(t, 1, { ...post, platform });
    const result = await archivePlatformDownload(f.downloaded, { downloadDir: f.root, instagramArchiveLayout: 'legacy' });
    assert.equal(result.filename, 'asset_001.mp4');
    assert.equal(result.archiveLayout, undefined);
    assert.equal(path.basename(path.dirname(result.filePath)).startsWith(post.remoteId), true);
  }
});
test('Layout configuration accepts only daily and legacy', async () => {
  const { loadConfig } = await import('../src/config.js');
  assert.equal(loadConfig({}).instagramArchiveLayout, 'daily');
  assert.equal(loadConfig({ INSTAGRAM_ARCHIVE_LAYOUT: ' legacy ' }).instagramArchiveLayout, 'legacy');
  assert.throws(() => loadConfig({ INSTAGRAM_ARCHIVE_LAYOUT: '../elsewhere' }), /daily or legacy/);
});
