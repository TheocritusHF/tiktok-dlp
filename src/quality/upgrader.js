import { execFile as callbackExecFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const execFile = promisify(callbackExecFile);
const HOUR = 60 * 60 * 1000;
const RETRY_DELAY_MS = HOUR;
const MAX_ATTEMPTS_PER_STAGE = 2;

export function hasHigherResolution(candidate, current) {
  if (!candidate || !current) return false;
  const a = [Number(candidate.width), Number(candidate.height)].sort((x, y) => x - y);
  const b = [Number(current.width), Number(current.height)].sort((x, y) => x - y);
  return a[0] > 0 && b[0] > 0 && a[0] >= b[0] && a[1] >= b[1]
    && a[0] * a[1] > b[0] * b[1];
}

export function bestAdvertisedVideo(formats) {
  if (!Array.isArray(formats)) return null;
  const videos = formats.filter((entry) =>
    entry && String(entry.vcodec ?? 'none') !== 'none'
    && Number(entry.width) > 0 && Number(entry.height) > 0);
  return videos.toSorted((a, b) =>
    (Number(b.width) * Number(b.height) - Number(a.width) * Number(a.height))
    || (Number(b.tbr ?? 0) - Number(a.tbr ?? 0)))[0] ?? null;
}

export async function inspectVideoResolution(filePath, { executable = 'ffprobe' } = {}) {
  const { stdout } = await execFile(executable, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name', '-of', 'json', filePath,
  ], { timeout: 20_000, maxBuffer: 1024 * 1024 });
  const stream = JSON.parse(stdout)?.streams?.[0];
  if (!(Number(stream?.width) > 0 && Number(stream?.height) > 0)) {
    throw new Error(`ffprobe could not verify a video stream: ${filePath}`);
  }
  return { width: Number(stream.width), height: Number(stream.height), codec: stream.codec_name ?? '' };
}

/** Keeps the same archived path/file_id so existing download links remain valid. */
export class QualityUpgrader {
  constructor({ store, config, probeVideo, downloadVideo, inspect = inspectVideoResolution,
    onUpgrade = null, logger = console, now = () => Date.now(),
    pollIntervalMs = 15 * 60_000, batchSize = 2,
  } = {}) {
    if (!store || !config?.downloadDir || !probeVideo || !downloadVideo) {
      throw new Error('QualityUpgrader requires store, downloadDir, probeVideo and downloadVideo.');
    }
    Object.assign(this, { store, config, probeVideo, downloadVideo, inspect, onUpgrade, logger, now,
      pollIntervalMs, batchSize });
    this.timer = null;
    this.inFlight = null;
  }

  async start() {
    // Without ffprobe, leave scheduled checks intact instead of exhausting retries.
    try {
      await execFile('ffprobe', ['-version'], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    } catch (error) {
      this.logger.warn?.(`[quality] ffprobe is unavailable; delayed quality checks are disabled until it is installed: ${error.message}`);
      return this;
    }
    const seeded = this.store.backfillRecentQualityUpgrades?.(this.now()) ?? 0;
    if (seeded) this.logger.info?.(`[quality] Scheduled ${seeded} recent monitored post(s).`);
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => this.logger.error?.(`[quality] Worker error: ${error.message}`));
    }, this.pollIntervalMs);
    this.timer.unref?.();
    void this.runOnce().catch((error) => this.logger.error?.(`[quality] Initial check failed: ${error.message}`));
    return this;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight.catch(() => {});
  }

  runOnce() {
    if (this.inFlight) return this.inFlight;
    const promise = this.#runBatch().finally(() => {
      if (this.inFlight === promise) this.inFlight = null;
    });
    this.inFlight = promise;
    return promise;
  }

  async #runBatch() {
    // Recover a crash after the file swap but before the DB commit, including
    // completed rows whose .quality-backup cleanup was interrupted.
    const records = this.store.listQualityUpgradeRecords?.(500) ?? [];
    for (const record of records) {
      const backup = `${record.path}.quality-backup`;
      if (await fileExists(backup)) {
        try { await recoverBackup(record, backup, this.config.downloadDir, this.logger); }
        catch (error) { this.logger.warn?.(`[quality] Recovery needed for ${record.video_id}: ${error.message}`); }
      }
    }
    const due = this.store.listDueQualityUpgrades(this.now(), this.batchSize);
    for (const record of due) await this.#check(record);
    return due.length;
  }

  async #check(record) {
    const stage = Number(record.stage);
    const originalPath = record.path;
    let staging = null;
    try {
      if (!isArchivedVideo(record, this.config.downloadDir)) {
        this.store.finishQualityUpgrade(record.file_id, 'Not an active TikTok video archive.', this.now());
        return;
      }
      if (await fileExists(`${originalPath}.quality-backup`)) {
        this.logger.warn?.(`[quality] Recovery needed for ${record.video_id}; preserving its scheduled check.`);
        return;
      }
      if (this.store.isQualityUpgradePathExclusive?.(record.file_id) === false) {
        this.store.finishQualityUpgrade(record.file_id,
          'Another active file record uses this path; manual review required.', this.now());
        return;
      }
      const original = await this.inspect(originalPath);
      const metadata = await this.probeVideo(record.source_url, this.config);
      if (String(metadata?.id ?? '') !== String(record.video_id)) {
        throw new Error('Probe returned a different post ID; original archive was not changed.');
      }
      if (isNonVideoMetadata(metadata)) {
        this.store.finishQualityUpgrade(record.file_id, 'Story or slideshow: no quality upgrade.', this.now());
        return;
      }
      const best = bestAdvertisedVideo(metadata.formats);
      if (!hasHigherResolution(best, original)) {
        this.store.completeQualityCheck(record.file_id, stage, this.now());
        this.logger.info?.(`[quality] ${record.video_id}: ${stageLabel(stage)} — no higher resolution than ${original.width}x${original.height}.`);
        return;
      }
      staging = await mkdtemp(path.join(this.config.downloadDir, '.quality-stage-'));
      const downloaded = await this.downloadVideo(record.source_url, {
        ...this.config, downloadDir: undefined, outputDir: staging, metadata, format: 'bv*+ba/b',
      });
      const candidatePath = downloaded?.primaryFile || downloaded?.filePath;
      if (!candidatePath || !isInsideDirectory(candidatePath, staging) || !await fileExists(candidatePath)) {
        throw new Error('The downloaded replacement was not found in the temporary directory.');
      }
      const candidate = await this.inspect(candidatePath);
      if (!hasHigherResolution(candidate, original)) {
        this.store.completeQualityCheck(record.file_id, stage, this.now());
        this.logger.info?.(`[quality] ${record.video_id}: downloaded candidate was not higher resolution; original preserved.`);
        return;
      }
      const sizeBytes = (await stat(candidatePath)).size;
      const originalStats = await stat(originalPath);
      if (Number(originalStats.size) !== Number(record.size_bytes)) {
        throw new Error('Archived file has changed since it was read; refusing to overwrite it.');
      }
      const backup = `${originalPath}.quality-backup`;
      await copyFile(originalPath, backup, fsConstants.COPYFILE_EXCL); // Never overwrite a recovery copy.
      try {
        await rename(candidatePath, originalPath); // Atomic same-volume replacement.
        this.store.commitQualityUpgrade(record.file_id, stage, {
          sizeBytes, width: candidate.width, height: candidate.height,
        }, this.now());
      } catch (error) {
        await rename(backup, originalPath).catch((rollbackError) => {
          this.logger.error?.(`[quality] RESTORE REQUIRED: ${backup} -> ${originalPath}: ${rollbackError.message}`);
        });
        throw error;
      }
      await rm(backup, { force: true }).catch((error) =>
        this.logger.warn?.(`[quality] Retained safety copy ${backup}: ${error.message}`));
      await refreshInfoJson(staging, originalPath).catch((error) =>
        this.logger.warn?.(`[quality] Metadata refresh skipped for ${record.video_id}: ${error.message}`));
      this.logger.info?.(`[quality] UPGRADED ${record.video_id}: ${original.width}x${original.height} -> ${candidate.width}x${candidate.height} (${stageLabel(stage)}).`);
      if (this.onUpgrade) {
        try {
          await this.onUpgrade({
            videoId: record.video_id, username: record.username, sourceUrl: record.source_url,
            previous: original, current: candidate, stage: stageLabel(stage),
          });
        } catch (error) {
          this.logger.warn?.(`[quality] Upgrade notification failed for ${record.video_id}: ${error.message}`);
        }
      }
    } catch (error) {
      this.logger.warn?.(`[quality] ${record.video_id} ${stageLabel(stage)} failed: ${error.message}`);
      // If an interrupted replacement left a safety copy, do not allow the
      // scheduler to advance until the next batch has attempted recovery.
      if (await fileExists(`${originalPath}.quality-backup`)) return;
      try { this.store.failQualityCheck(record.file_id, stage, error.message, this.now(), RETRY_DELAY_MS, MAX_ATTEMPTS_PER_STAGE); }
      catch (dbError) { this.logger.error?.(`[quality] Could not save failure: ${dbError.message}`); }
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export function isArchivedVideo(record, downloadDir) {
  const kind = String(record.media_type ?? '').toLowerCase();
  return record.platform === 'tiktok' && record.retention_status === 'active'
    && /\/video\/\d+/.test(String(record.source_url ?? ''))
    && !/story|photo|slide/.test(kind)
    && path.extname(String(record.path ?? '')).toLowerCase() === '.mp4'
    && isInsideDirectory(record.path, downloadDir);
}

function isNonVideoMetadata(metadata) {
  const type = String(metadata?.mediaType ?? metadata?.media_type ?? metadata?.type ?? '').toLowerCase();
  return /story|slide|photo/.test(type) || (Array.isArray(metadata?.images) && metadata.images.length > 0);
}

function isInsideDirectory(filePath, directory) {
  const rel = path.relative(path.resolve(directory), path.resolve(String(filePath ?? '')));
  return Boolean(rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function fileExists(filePath) {
  try { await stat(filePath); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function recoverBackup(record, backup, downloadDir, logger) {
  if (!isArchivedVideo(record, downloadDir)) return;
  const originalExists = await fileExists(record.path);
  if (!originalExists) {
    await rename(backup, record.path);
    logger.warn?.(`[quality] Restored missing archive file ${record.video_id} from safety copy.`);
    return;
  }
  const [currentStat, backupStat] = await Promise.all([stat(record.path), stat(backup)]);
  if (Number(currentStat.size) === Number(record.size_bytes)) {
    await rm(backup);
    return;
  }
  if (Number(backupStat.size) === Number(record.size_bytes)) {
    // DB still refers to the old bytes. Preserve the uncommitted candidate.
    await rename(record.path, `${record.path}.quality-interrupted-${Date.now()}`);
    await rename(backup, record.path);
    logger.warn?.(`[quality] Rolled back uncommitted upgrade for ${record.video_id}.`);
    return;
  }
  throw new Error(`Uncertain original/backup sizes for file ${record.file_id}; inspect manually.`);
}

async function refreshInfoJson(stagingDir, archivedVideoPath) {
  const files = await readdir(stagingDir);
  const source = files.find((name) => name.endsWith('.info.json'));
  if (!source) return;
  const json = await readFile(path.join(stagingDir, source), 'utf8');
  JSON.parse(json); // Never replace saved metadata with an invalid JSON file.
  const target = archivedVideoPath.replace(/\.[^.]+$/, '.info.json');
  const temp = `${target}.quality-new`;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(temp, json);
  await rename(temp, target);
}

function stageLabel(stage) { return ['6h', '24h', '72h'][stage] ?? `stage${stage}`; }
export const qualityCheckHours = Object.freeze([6, 24, 72]);
export const qualityCheckMs = qualityCheckHours.map((h) => h * HOUR);
