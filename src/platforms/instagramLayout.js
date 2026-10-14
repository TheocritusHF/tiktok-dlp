import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const INSTAGRAM_ARCHIVE_LAYOUT = 'instagram-daily-v1';

export function instagramLayout(post, downloadDir, assets, { now = Date.now(), suffix = '' } = {}) {
  if (post?.platform !== 'instagram') throw new Error('Instagram layout requires an Instagram post.');
  const creator = safePart(post.creator?.handle || 'unknown', 30).toLowerCase();
  const remoteId = safePart(post.remoteId, 64);
  const kind = post.mediaType === 'highlight' || remoteId.startsWith('highlight_') ? 'Highlights'
    : post.mediaType === 'story' || remoteId.startsWith('story_') ? 'Stories' : 'Posts';
  const date = archiveDate(post.publishedAt, now);
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const identity = /^(?:story|post|highlight)_/.test(remoteId) ? remoteId
    : `${kind === 'Stories' ? 'story' : kind === 'Highlights' ? 'highlight' : 'post'}_${remoteId}`;
  if (suffix && !/^[A-Za-z0-9_-]{1,32}$/.test(suffix)) throw new Error('Invalid archive suffix.');
  const base = `${stamp}__${creator}__${identity}${suffix ? `__${suffix}` : ''}`;
  const directory = path.join(path.resolve(downloadDir), 'instagram', creator, kind,
    String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'));
  if (!Array.isArray(assets) || !assets.length) throw new Error('Instagram assets are required.');
  const filenames = assets.map((asset, index) => {
    const extension = path.extname(String(asset.filename || asset.path || asset.filePath || '')).toLowerCase();
    if (!/^\.[a-z0-9]{1,12}$/.test(extension)) throw new Error('Invalid Instagram asset extension.');
    return `${base}${assets.length > 1 ? `__${String(index + 1).padStart(3, '0')}` : ''}${extension}`;
  });
  return { directory, base, filenames, bundlePath: assets.length > 1 ? path.join(directory, '_bundles', `${base}.zip`) : '' };
}

export async function archiveInstagramDownload(downloaded, { downloadDir, now = Date.now(), createZip } = {}) {
  const root = path.resolve(downloadDir);
  const sourceDir = path.resolve(downloaded.outputDir);
  if (!outside(sourceDir, root)) throw new Error('The staging directory must not contain the archive.');
  const rawAssets = [...downloaded.assets].sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
  const sources = [];
  for (const asset of rawAssets) {
    const source = path.resolve(String(asset.filePath || asset.path || ''));
    if (outside(sourceDir, source)) throw new Error(`Downloaded asset ${sources.length + 1} is outside its staging directory.`);
    await assertRegularFile(sourceDir, source);
    sources.push(source);
  }
  await ensureDirectory(root, root);
  const work = await mkdtemp(path.join(root, '.instagram-layout-staging-'));
  let owned = [];
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const layout = instagramLayout(downloaded.post, root, rawAssets, { now,
        suffix: attempt ? `copy_${randomBytes(6).toString('hex')}` : '' });
      const assets = rawAssets.map((asset, i) => ({ ...asset, filename: layout.filenames[i],
        path: path.join(layout.directory, layout.filenames[i]), filePath: path.join(layout.directory, layout.filenames[i]) }));
      await ensureDirectory(root, layout.directory);
      if (layout.bundlePath) await ensureDirectory(root, path.dirname(layout.bundlePath));
      let stagedZip = '';
      if (layout.bundlePath) {
        stagedZip = path.join(work, 'bundle.zip');
        const manifest = path.join(work, 'manifest.json');
        await writeFile(manifest, JSON.stringify({ platform: 'instagram', remoteId: downloaded.post.remoteId,
          canonicalUrl: downloaded.post.canonicalUrl || '', creator: downloaded.post.creator || null,
          caption: downloaded.post.caption || '', publishedAt: downloaded.post.publishedAt ?? null,
          mediaType: downloaded.post.mediaType || '', assets: assets.map((asset) => ({ position: asset.position, remoteId: asset.remoteId || '', kind: asset.kind || '',
            mimeType: asset.mimeType || '', filename: asset.filename, width: asset.width ?? null, height: asset.height ?? null,
            duration: asset.duration ?? null, altText: asset.altText || '' })) }, null, 2));
        const zip = createZip || (await import('../tiktok/ytdlp.js')).createZipFile;
        await zip(stagedZip, [...assets.map((asset, i) => ({ name: asset.filename, filePath: sources[i] })),
          { name: 'manifest.json', filePath: manifest }]);
      }
      try {
        for (let i = 0; i < sources.length; i += 1) {
          await exclusiveCopy(sources[i], assets[i].path, owned);
        }
        if (stagedZip) await exclusiveCopy(stagedZip, layout.bundlePath, owned);
        const filePath = layout.bundlePath || assets[0].path;
        const result = { ...downloaded, assets, outputDir: layout.directory,
          archiveLayout: INSTAGRAM_ARCHIVE_LAYOUT, ownedArchiveFiles: [...owned], filePath,
          primaryFile: assets[0].path, bundlePath: layout.bundlePath, filename: path.basename(filePath),
          sizeBytes: (await lstat(filePath)).size };
        await rm(sourceDir, { recursive: true, force: true });
        return result;
      } catch (error) {
        await removeExactFiles(owned); owned = [];
        if (error.code !== 'EEXIST') throw error;
        if (stagedZip) await rm(stagedZip, { force: true });
      }
    }
    throw new Error('Could not reserve unique Instagram filenames.');
  } catch (error) {
    await removeExactFiles(owned);
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// The caller invokes this only after confirming the database did not commit.
export async function removeUnpersistedInstagramFiles(downloadDir, extracted) {
  const root = path.resolve(downloadDir);
  if (extracted?.archiveLayout !== INSTAGRAM_ARCHIVE_LAYOUT || extracted.post?.platform !== 'instagram'
    || !Array.isArray(extracted.ownedArchiveFiles)) throw new Error('Missing Instagram archive ownership.');
  const outputDir = path.resolve(String(extracted.outputDir || ''));
  if (!/^instagram\/[^/]+\/(?:Stories|Posts|Highlights)\/\d{4}\/\d{2}\/\d{2}$/.test(path.relative(root, outputDir).split(path.sep).join('/'))) {
    throw new Error('Invalid Instagram daily archive directory.');
  }
  for (const filename of extracted.ownedArchiveFiles) {
    const target = path.resolve(filename);
    const rel = path.relative(outputDir, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)
      || (path.dirname(target) !== outputDir && path.dirname(target) !== path.join(outputDir, '_bundles'))) {
      throw new Error('Invalid Instagram owned file path.');
    }
    await ensureExistingParents(root, path.dirname(target));
    try { await assertRegularFile(root, target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  }
  await removeExactFiles(extracted.ownedArchiveFiles);
}

async function exclusiveCopy(source, target, owned) {
  try { await copyFile(source, target, constants.COPYFILE_EXCL); owned.push(target); }
  catch (error) { throw error; }
}
async function removeExactFiles(files) {
  for (const file of files) await rm(file, { force: true });
}
export async function assertRegularFile(root, filename) {
  if (outside(root, filename)) throw new Error('Archive file is outside its root.');
  await ensureExistingParents(root, path.dirname(filename));
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Archive entry must be a regular file.');
  return info;
}
export async function ensureDirectory(root, directory) {
  if (path.resolve(root) !== path.resolve(directory) && outside(root, directory)) throw new Error('Archive directory is outside its root.');
  // Inspect every existing ancestor, including the root itself, before creating children.
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Archive directory must not be a symbolic link.');
  }
}
async function ensureExistingParents(root, directory) {
  if (path.resolve(root) !== path.resolve(directory) && outside(root, directory)) throw new Error('Archive path is outside its root.');
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Archive parent must not be a symbolic link.');
  }
}
export function outside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}
function safePart(value, max) {
  const text = String(value || '').trim();
  if (!text || text.length > max || !/^[A-Za-z0-9_.-]+$/.test(text) || text.includes('..') || text.startsWith('.')) throw new Error('Invalid Instagram archive identity.');
  return text;
}
function archiveDate(value, fallback) {
  const number = typeof value === 'number' ? value : null;
  const date = value instanceof Date ? value : number != null ? new Date(number > 10_000_000_000 ? number : number * 1000)
    : typeof value === 'string' && value.trim() ? new Date(value) : new Date(fallback);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1970 || date.getUTCFullYear() > 9999) throw new Error('Invalid Instagram archive date.');
  return date;
}

export async function assertExistingDirectory(directory) {
  await ensureExistingParents(directory, directory);
}
