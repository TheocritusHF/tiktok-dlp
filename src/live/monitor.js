import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import {
  captureTikTokLive, inspectRecordedMedia, largestRecordedFile, liveUrl,
  probeTikTokLive, remuxRecordedMedia,
} from './yt-dlp.js';

const POLL_MINIMUM_MS = 60_000;
const START_RETRY_MS = 120_000;
const MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60_000;

export function liveArchiveId(roomId, startedAt) {
  if (!/^\d{5,30}$/.test(String(roomId))) throw new Error('A numeric room ID is required.');
  if (!Number.isSafeInteger(Number(startedAt)) || Number(startedAt) <= 0) throw new Error('A start timestamp is required.');
  return `live_${roomId}_${startedAt}`;
}

async function hasFreeDisk(dir, requiredGb) {
  if (!requiredGb) return true;
  const disk = await statfs(dir);
  return disk.bavail * disk.bsize >= requiredGb * 1024 ** 3;
}

/** Separate, opt-in TikTok LIVE worker. Never modifies the post/story poller. */
export class LiveMonitor {
  constructor({ store, config, probe = probeTikTokLive, capture = captureTikTokLive,
    remux = remuxRecordedMedia, inspect = inspectRecordedMedia,
    onStart = null, onComplete = null, logger = console, now = () => Date.now(),
  } = {}) {
    if (!store?.listWatches || !store?.createFileWithMedia || !config?.downloadDir || !config?.dataDir) {
      throw new Error('LiveMonitor requires the existing archive store and download/data directories.');
    }
    Object.assign(this, { store, config, probe, capture, remux, inspect, onStart, onComplete, logger, now });
    this.root = path.join(config.dataDir, 'live');
    this.sessionDir = path.join(this.root, 'sessions');
    this.stageRoot = path.join(this.root, 'staging');
    this.cookiesDir = path.join(this.root, 'private-cookies');
    this.pollMs = Math.max(POLL_MINIMUM_MS, Number(config.livePollSeconds || 120) * 1_000);
    this.maxConcurrent = Math.max(1, Math.min(8, Number(config.liveMaxConcurrent || 2)));
    this.probeConcurrency = Math.max(1, Math.min(5, Number(config.liveProbeConcurrency || 2)));
    this.allowedHandles = new Set(config.liveHandles ?? []);
    this.active = new Map();
    this.attempted = new Map();
    this.lastErrorAt = new Map();
    this.running = false;
    this.stopping = false;
    this.timer = null;
    this.inFlight = null;
    this.cookieCopy = '';
    this.runtimeConfig = null;
  }

  async start() {
    if (this.running) return this;
    this.stopping = false;
    await Promise.all([
      mkdir(this.sessionDir, { recursive: true }),
      mkdir(this.stageRoot, { recursive: true }),
      mkdir(this.config.downloadDir, { recursive: true }),
    ]);
    // There is never a valid child recorder from a previous container instance.
    await rm(this.cookiesDir, { recursive: true, force: true });
    await mkdir(this.cookiesDir, { recursive: true, mode: 0o700 });
    if (this.config.ytdlpCookiesFile) {
      this.cookieCopy = path.join(this.cookiesDir, `cookies-${randomUUID()}.txt`);
      await copyFile(this.config.ytdlpCookiesFile, this.cookieCopy);
      await chmod(this.cookieCopy, 0o600);
    }
    this.runtimeConfig = { ...this.config, liveCookiesFile: this.cookieCopy };
    this.running = true;
    try {
      await this.#recoverSessions();
    } catch (error) {
      this.logger.error?.(`[live] Recovery failed; staged recordings have been preserved: ${error.message}`);
    }
    this.logger.info?.(`[live] Automatic recording enabled; checking watched TikTok accounts every ${this.pollMs / 1_000}s.`);
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => this.logger.error?.(`[live] Monitor cycle failed: ${error.message}`));
    }, this.pollMs);
    this.timer.unref?.();
    void this.runOnce().catch((error) => this.logger.error?.(`[live] Initial scan failed: ${error.message}`));
    return this;
  }

  async stop() {
    this.stopping = true;
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
    for (const entry of this.active.values()) entry.handle?.stop();
    // Do not remux multi-hour recordings inside Docker's shutdown grace period.
    // If remuxing a long recording is already in progress, leave its session journal
    // at 'finalizing' and finish it on the next startup rather than blocking SIGTERM.
    const tasks = [...this.active.values()].map((entry) => entry.completion ?? entry.handle?.done);
    let deadline;
    try {
      await Promise.race([
        Promise.allSettled(tasks),
        new Promise((resolve) => { deadline = setTimeout(resolve, 25_000); }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    if (this.inFlight) await this.inFlight.catch(() => {});
    if (this.cookieCopy) await rm(this.cookieCopy, { force: true });
    this.cookieCopy = '';
  }

  runOnce() {
    if (this.inFlight) return this.inFlight;
    const task = this.#cycle().finally(() => { if (this.inFlight === task) this.inFlight = null; });
    this.inFlight = task;
    return task;
  }

  async #cycle() {
    if (!this.running || this.stopping) return;
    await this.#retryArchivedNotifications();
    const watches = await Promise.resolve(this.store.listWatches({ platform: 'tiktok' }));
    const uniqueHandles = new Map();
    for (const watch of watches) {
      if (watch.platform && watch.platform !== 'tiktok') continue;
      const username = String(watch.username ?? '').trim();
      const lower = username.toLowerCase();
      if (!/^[a-z0-9._]{1,32}$/.test(lower) || lower.includes('..') || lower.startsWith('.') || lower.endsWith('.')) continue;
      if (this.allowedHandles.size && !this.allowedHandles.has(lower)) continue;
      if (!uniqueHandles.has(lower)) uniqueHandles.set(lower, username);
    }
    const handles = [...uniqueHandles.values()];
    // Parallelize only lightweight probes; actual recording starts remain serial
    // so the active-recording limit cannot be exceeded by a race.
    for (let offset = 0; offset < handles.length; offset += this.probeConcurrency) {
      if (!this.running || this.stopping || this.active.size >= this.maxConcurrent) break;
      const batch = handles.slice(offset, offset + this.probeConcurrency)
        .filter((username) => !this.active.has(username.toLowerCase()));
      const detected = await Promise.all(batch.map(async (username) => {
        try {
          return { username, live: await this.probe(username, this.runtimeConfig) };
        } catch (error) {
          // A failed probe is NOT evidence the creator is offline.
          if (this.now() - (this.lastErrorAt.get(username.toLowerCase()) ?? 0) > 15 * 60_000) {
            this.logger.warn?.(`[live] @${username}: ${error.message}`);
            this.lastErrorAt.set(username.toLowerCase(), this.now());
          }
          return { username, live: null };
        }
      }));
      for (const { username, live } of detected) {
        if (!this.running || this.stopping || this.active.size >= this.maxConcurrent) break;
        if (!live || this.active.has(username.toLowerCase())) continue;
        const key = `${username.toLowerCase()}:${live.roomId}`;
        if (this.now() - (this.attempted.get(key) ?? 0) < START_RETRY_MS) continue;
        try {
          if (!await hasFreeDisk(this.config.downloadDir, this.config.liveMinFreeGb ?? 10)) {
            this.logger.warn?.(`[live] Cannot start @${username}; free disk space is below ${this.config.liveMinFreeGb} GB.`);
            continue;
          }
          await this.#startCapture(username, live);
          this.attempted.set(key, this.now());
        } catch (error) {
          this.logger.error?.(`[live] Cannot start @${username}: ${error.message}`);
          this.attempted.set(key, this.now());
        }
      }
    }
  }

  async #startCapture(username, live) {
    const startedAt = this.now();
    const sessionId = randomUUID();
    const stagingDir = path.join(this.stageRoot, sessionId);
    await mkdir(stagingDir, { recursive: true });
    const session = {
      sessionId, username, roomId: live.roomId,
      title: live.title ?? '', startedAt, archiveId: liveArchiveId(live.roomId, startedAt),
      stagingDir, sourceUrl: liveUrl(username),
      phase: 'recording', fileId: null, partial: false, announcedStart: false,
    };
    await this.#writeSession(session);
    const entry = { session, handle: null, startedNotification: null, diskTimer: null, maxTimer: null };
    this.active.set(username.toLowerCase(), entry);
    try {
      entry.handle = this.capture(session, this.runtimeConfig, {
        logger: this.logger,
        onFirstData: () => {
          if (session.announcedStart) return;
          session.announcedStart = true;
          entry.startedNotification = Promise.resolve(this.onStart?.({ ...session }))
            .catch((error) => this.logger.warn?.(`[live] Recording started but start alert failed for @${username}: ${error.message}`));
        },
      });
      entry.diskTimer = setInterval(() => {
        void hasFreeDisk(this.config.downloadDir, this.config.liveMinFreeGb ?? 10)
          .then((okay) => {
            if (!okay && !this.stopping) {
              session.stopReason = 'low_disk';
              this.logger.warn?.(`[live] Low disk space; stopping @${username}'s recording without deleting the captured bytes.`);
              entry.handle?.stop();
            }
          }).catch((error) => this.logger.warn?.(`[live] Disk check failed: ${error.message}`));
      }, 60_000);
      entry.diskTimer.unref?.();
      const maxHours = Number(this.config.liveMaxHours ?? 8);
      if (maxHours > 0) {
        entry.maxTimer = setTimeout(() => {
          session.stopReason = 'segment_limit';
          entry.handle?.stop();
        }, maxHours * 3_600_000);
        entry.maxTimer.unref?.();
      }
      entry.completion = this.#captureFinished(entry);
      this.logger.info?.(`[live] Recording @${username}, room ${live.roomId}.`);
    } catch (error) {
      this.active.delete(username.toLowerCase());
      clearInterval(entry.diskTimer);
      clearTimeout(entry.maxTimer);
      session.phase = 'failed';
      session.error = `Recording process could not start: ${String(error.message).slice(0, 240)}`;
      await this.#writeSession(session);
      throw error;
    }
  }

  async #captureFinished(entry) {
    const { session, handle } = entry;
    try {
      const exit = await handle.done;
      clearInterval(entry.diskTimer);
      clearTimeout(entry.maxTimer);
      await entry.startedNotification;
      if (this.stopping) return; // On next startup the recovery pass finalizes the partial capture.
      session.partial = exit.code !== 0 || Boolean(session.stopReason);
      await this.#finalize(session);
    } catch (error) {
      // A remux or DB failure must remain recoverable on the next startup.
      session.phase = session.phase === 'finalizing' ? 'finalizing' : 'failed';
      session.error = String(error.message).slice(0, 400);
      await this.#writeSession(session).catch(() => {});
      this.logger.error?.(`[live] @${session.username}: recording could not be archived: ${error.message}. Source kept in ${session.stagingDir}`);
    } finally {
      this.active.delete(session.username.toLowerCase());
      clearInterval(entry.diskTimer);
      clearTimeout(entry.maxTimer);
    }
  }

  async #finalize(session) {
    if (session.phase === 'complete') return;
    if (session.phase === 'archived') return this.#notifyComplete(session);
    session.phase = 'finalizing';
    await this.#writeSession(session);
    const folder = path.join(this.config.downloadDir, 'lives', session.username,
      new Date(session.startedAt).toISOString().slice(0, 10));
    await mkdir(folder, { recursive: true });
    const basename = `${session.roomId}_${session.startedAt}`;
    const basePath = path.join(folder, basename);
    const existing = this.store.getLatestFileByPost?.('tiktok', session.archiveId);
    let dest = existing?.path;
    let media;
    if (existing) {
      if (!dest || !(await stat(dest).catch(() => null))?.isFile()) {
        throw new Error('The database has a LIVE archive record, but its saved file is missing.');
      }
      media = await this.inspect(dest);
      session.fileId = existing.id;
    } else {
      // An interrupted process may have atomically moved the verified output
      // but died before committing its DB row. Do not require a raw source then.
      for (const ext of ['mp4', 'mkv', 'flv', 'ts', 'webm']) {
        const candidate = `${basePath}.${ext}`;
        if ((await stat(candidate).catch(() => null))?.isFile()) {
          dest = candidate;
          break;
        }
      }
      if (dest) {
        media = await this.inspect(dest);
      } else {
        const source = await largestRecordedFile(session.stagingDir);
        if (!source || source.bytes < 64 * 1024) {
          throw new Error('No recoverable recording was found (the LIVE may have ended before data arrived).');
        }
        const remuxed = await this.remux(source.path, basePath, { inspect: this.inspect });
        if (this.stopping) return; // Leave source and journal intact for startup recovery.
        dest = `${basePath}.${remuxed.ext}`;
        // Move only verified content to a stable path, then commit the DB row.
        await rename(remuxed.tempPath, dest);
        media = await this.inspect(dest);
      }
      const fileStat = await stat(dest);
      if (this.stopping) return; // The destination and source survive a graceful stop.
      const file = {
        platform: 'tiktok', videoId: session.archiveId, username: session.username,
        sourceUrl: session.sourceUrl, filePath: dest, filename: path.basename(dest),
        sizeBytes: fileStat.size,
      };
      const data = {
        platform: 'tiktok', remoteId: session.archiveId,
        canonicalUrl: session.sourceUrl, sourceUrl: session.sourceUrl,
        creatorHandle: session.username, title: session.title || `LIVE recording by @${session.username}`,
        mediaType: 'live', publishedAt: session.startedAt,
        durationSeconds: media.duration,
        metadata: { liveRoomId: session.roomId, startedAt: session.startedAt,
          partial: session.partial, stopReason: session.stopReason ?? '' },
        filePath: dest, filename: path.basename(dest), sizeBytes: fileStat.size,
        assets: [{ path: dest, filename: path.basename(dest), sizeBytes: fileStat.size,
          kind: 'video', mimeType: path.extname(dest) === '.mp4' ? 'video/mp4'
            : path.extname(dest) === '.mkv' ? 'video/x-matroska'
              : path.extname(dest) === '.ts' ? 'video/mp2t' : 'video/x-flv',
          width: media.width, height: media.height, durationSeconds: media.duration }],
      };
      ({ fileId: session.fileId } = this.store.createFileWithMedia({ file, media: data }, this.now()));
    }
    // Retain LIVE recordings even if Discord is unavailable or has no target.
    // Existing cleanup removes unlinked downloads after its orphan grace period.
    // A private, permanent archive-scope token protects these files independently
    // from any target-specific Discord delivery tokens.
    const archiveScope = `live:archive:${session.archiveId}`;
    if (typeof this.store.createLinkToken === 'function'
      && !this.store.getPermanentMonitorDeliveryForFile?.(session.fileId, { scopeId: archiveScope })) {
      this.store.createLinkToken({
        token: randomBytes(24).toString('hex'),
        fileId: session.fileId, scopeId: archiveScope,
        deliveryType: 'monitor', expiresAt: 0,
      }, this.now());
    }
    const size = await stat(dest);
    session.archivePath = dest;
    session.sizeBytes = size.size;
    session.durationSeconds = media.duration;
    session.phase = 'archived';
    await this.#writeSession(session);
    // Clean raw recordings only after the file and DB row have both been committed.
    await rm(session.stagingDir, { recursive: true, force: true });
    this.logger.info?.(`[live] ARCHIVED @${session.username} room ${session.roomId}: ${path.basename(dest)} (${size.size} bytes).`);
    await this.#notifyComplete(session);
  }

  async #notifyComplete(session) {
    if (this.stopping) return;
    try {
      await this.onComplete?.({ ...session });
      session.phase = 'complete';
      delete session.notifyError;
      await this.#writeSession(session);
    } catch (error) {
      session.phase = 'archived';
      session.notifyError = String(error.message).slice(0, 400);
      session.lastNotifyAttemptAt = this.now();
      await this.#writeSession(session);
      this.logger.warn?.(`[live] @${session.username} archived successfully; Discord alert will retry: ${error.message}`);
    }
  }

  async #retryArchivedNotifications() {
    const sessions = await this.#readSessions();
    for (const session of sessions.filter((item) => item.phase === 'archived')) {
      if (this.stopping) return;
      if (this.now() - (session.lastNotifyAttemptAt ?? 0) < 5 * 60_000) continue;
      await this.#notifyComplete(session);
    }
  }

  async #recoverSessions() {
    const sessions = await this.#readSessions();
    for (const session of sessions) {
      if (!this.running || this.stopping) return;
      const age = this.now() - Number(session.startedAt);
      if (age < 0 || age > MAX_SESSION_AGE_MS) continue;
      if (['recording', 'finalizing'].includes(session.phase)) {
        try {
          session.partial = true;
          await this.#finalize(session);
        } catch (error) {
          session.phase = 'failed';
          session.error = `Recovery failed: ${String(error.message).slice(0, 320)}`;
          await this.#writeSession(session);
          this.logger.warn?.(`[live] Could not recover @${session.username}: ${error.message}`);
        }
      } else if (session.phase === 'archived') {
        await this.#notifyComplete(session);
      }
    }
  }

  async #readSessions() {
    const filenames = (await readdir(this.sessionDir)).filter((name) => /^[\da-f-]{36}\.json$/.test(name));
    const all = [];
    for (const filename of filenames) {
      try {
        const session = JSON.parse(await readFile(path.join(this.sessionDir, filename), 'utf8'));
        if (session?.sessionId + '.json' !== filename) continue;
        if (!/^[a-z0-9._]{1,32}$/i.test(session.username) || session.username.includes('..') || session.username.startsWith('.') || session.username.endsWith('.') || !/^\d{5,30}$/.test(String(session.roomId))) continue;
        if (session.stagingDir !== path.join(this.stageRoot, session.sessionId)) continue;
        all.push(session);
      } catch (error) { this.logger.warn?.(`[live] Could not read recovery state ${filename}: ${error.message}`); }
    }
    return all;
  }

  async #writeSession(session) {
    const filename = path.join(this.sessionDir, `${session.sessionId}.json`);
    const temp = path.join(this.sessionDir, `${session.sessionId}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(session, null, 2), { mode: 0o600 });
      await rename(temp, filename);
    } finally {
      await rm(temp, { force: true });
    }
  }
}
