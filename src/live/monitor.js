import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { discoverLiveFormats, qualityImproves } from './adaptive-quality.js';
import {
  captureTikTokLive, inspectRecordedMedia, largestRecordedFile, liveUrl,
  probeTikTokLive, remuxRecordedMedia,
} from './yt-dlp.js';
import { captureWebcastLive, probeWebcastLive } from './webcast.js';

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
    webcastProbe = probeWebcastLive, webcastCapture = captureWebcastLive,
    remux = remuxRecordedMedia, inspect = inspectRecordedMedia,
    discover = discoverLiveFormats,
    qualityStartDelayMs = 20_000, qualityPollMs = 2_000,
    qualitySampleMs = null, qualityStableMs = 5_000,
    onStart = null, onComplete = null, logger = console, now = () => Date.now(),
  } = {}) {
    if (!store?.listWatches || !store?.createFileWithMedia || !config?.downloadDir || !config?.dataDir) {
      throw new Error('LiveMonitor requires the existing archive store and download/data directories.');
    }
    Object.assign(this, { store, config, probe, capture, webcastProbe, webcastCapture,
      remux, inspect, discover, onStart, onComplete, logger, now });
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
    this.qualityStartDelayMs = qualityStartDelayMs;
    this.qualityPollMs = qualityPollMs;
    this.qualitySampleMs = qualitySampleMs;
    this.qualityStableMs = qualityStableMs;
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
    for (const entry of this.active.values()) {
      clearInterval(entry.qualityTimer);
      clearTimeout(entry.qualityDelay);
      entry.cancelReconnectDelay?.();
      entry.trial?.handle?.stop();
      (entry.current?.handle ?? entry.handle)?.stop();
    }
    // Do not remux multi-hour recordings inside Docker's shutdown grace period.
    // If remuxing a long recording is already in progress, leave its session journal
    // at 'finalizing' and finish it on the next startup rather than blocking SIGTERM.
    const tasks = [...this.active.values()].flatMap((entry) =>
      [entry.completion ?? entry.handle?.done, entry.qualityTask].filter(Boolean));
    if (this.inFlight) tasks.push(this.inFlight);
    let deadline;
    try {
      await Promise.race([
        Promise.allSettled(tasks),
        new Promise((resolve) => { deadline = setTimeout(resolve, 25_000); }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    if (this.cookieCopy) await rm(this.cookieCopy, { force: true });
    this.cookieCopy = '';
  }

  runOnce() {
    if (this.inFlight) return this.inFlight;
    const task = this.#cycle().finally(() => { if (this.inFlight === task) this.inFlight = null; });
    this.inFlight = task;
    return task;
  }

  async #probeLive(username) {
    const live = await this.probe(username, this.runtimeConfig);
    if (live || !this.config.liveWebcastFallbackEnabled) return live;
    return this.webcastProbe(username, this.runtimeConfig);
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
          return { username, live: await this.#probeLive(username) };
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
    const adaptive = this.config.liveAdaptiveQualityEnabled === true;
    const segmented = adaptive || this.config.liveReconnectEnabled === true;
    if (segmented) session.segments = [];
    await this.#writeSession(session);
    const entry = {
      session, handle: null, current: null, trial: null,
      startedNotification: null, diskTimer: null, maxTimer: null,
      qualityTimer: null, qualityDelay: null, qualityTask: null,
      qualityFailures: new Map(),
      captureSource: live.source === 'webcast' ? 'webcast' : 'ytdlp',
      streamUrl: live.source === 'webcast' ? live.streamUrl : '',
      shortReconnects: 0, cancelReconnectDelay: null,
    };
    this.active.set(username.toLowerCase(), entry);
    try {
      if (this.stopping) throw new Error('LIVE recorder is stopping.');
      if (segmented) {
        // Start recording immediately. Quality discovery happens separately,
        // so a slow quality check cannot delay the initial capture.
        await this.#beginSegment(
          entry, entry.captureSource === 'webcast'
            ? 'webcast' : 'flv-hd/flv-hd1/rtmp-pull/hls-hd/hls-pull/best',
        );
        if (adaptive) {
          const intervalMs =
            Math.max(5, Number(this.config.liveQualityCheckMinutes || 15)) * 60_000;
          entry.qualityTimer = setInterval(
            () => this.#startQualityCheck(entry),
            intervalMs,
          );
          entry.qualityTimer.unref?.();
        }
      } else {
        // Preserve PR 1's original single-file recording behavior.
        const capture = entry.captureSource === 'webcast' ? this.webcastCapture : this.capture;
        entry.handle = capture(session, this.runtimeConfig, {
          logger: this.logger,
          streamUrl: entry.streamUrl,
          onFirstData: () => this.#notifyStarted(entry),
        });
        if (this.stopping) entry.handle.stop();
      }
      entry.diskTimer = setInterval(() => {
        void hasFreeDisk(this.config.downloadDir, this.config.liveMinFreeGb ?? 10)
          .then((okay) => {
            if (!okay && !this.stopping) {
              session.stopReason = 'low_disk';
              this.logger.warn?.(`[live] Low disk space; stopping @${username}'s recording without deleting the captured bytes.`);
              entry.trial?.handle?.stop();
              (entry.current?.handle ?? entry.handle)?.stop();
            }
          }).catch((error) => this.logger.warn?.(`[live] Disk check failed: ${error.message}`));
      }, 60_000);
      entry.diskTimer.unref?.();
      const maxHours = Number(this.config.liveMaxHours ?? 8);
      if (maxHours > 0) {
        entry.maxTimer = setTimeout(() => {
          session.stopReason = 'segment_limit';
          entry.trial?.handle?.stop();
          (entry.current?.handle ?? entry.handle)?.stop();
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

  #notifyStarted(entry) {
    const { session } = entry;
    if (session.announcedStart) return;
    session.announcedStart = true;
    entry.startedNotification = Promise.resolve(this.onStart?.({ ...session }))
      .catch((error) => this.logger.warn?.(
        `[live] Recording started but start alert failed for @${session.username}: ${error.message}`,
      ));
    void this.#writeSession(session).catch((error) =>
      this.logger.warn?.(`[live] Could not journal start notification: ${error.message}`));
    if (this.config.liveAdaptiveQualityEnabled && entry.captureSource !== 'webcast'
      && session.segments && !entry.qualityDelay) {
      entry.qualityDelay = setTimeout(
        () => this.#startQualityCheck(entry),
        this.qualityStartDelayMs,
      );
      entry.qualityDelay.unref?.();
    }
  }

  async #beginSegment(entry, format, { testing = false } = {}) {
    if (this.stopping || entry.session.stopReason) {
      throw new Error('LIVE recorder is stopping.');
    }

    const { session } = entry;
    const index = session.segments.length;
    const stagingDir = path.join(
      session.stagingDir, 'segments', String(index).padStart(3, '0'),
    );

    await mkdir(stagingDir, { recursive: true });

    const segment = {
      index,
      format,
      startedAt: this.now(),
      status: testing ? 'testing' : 'accepted',
    };

    session.segments.push(segment);

    // Persist the segment before starting its recorder for crash recovery.
    await this.#writeSession(session);

    if (this.stopping || session.stopReason) {
      throw new Error('LIVE recorder is stopping.');
    }

    const capture = entry.captureSource === 'webcast' ? this.webcastCapture : this.capture;
    const handle = capture(
      { ...session, stagingDir },
      this.runtimeConfig,
      {
        format,
        streamUrl: entry.streamUrl,
        logger: this.logger,
        onFirstData: () => {
          if (!testing) this.#notifyStarted(entry);
        },
      },
    );

    const result = { handle, segment, stagingDir };

    // Register the recorder immediately so shutdown can stop it.
    if (testing) {
      entry.trial = result;
    } else {
      entry.current = result;
      entry.handle = handle;
    }

    if (this.stopping || session.stopReason) {
      handle.stop();
    }

    return result;
  }
  #startQualityCheck(entry) {
    if (this.stopping || !this.running || entry.session.stopReason
      || entry.captureSource === 'webcast'
      || !entry.current || entry.qualityTask
      || !this.active.has(entry.session.username.toLowerCase())) return;

    const task = this.#checkQuality(entry)
      .catch((error) => this.logger.warn?.(
        `[live] @${entry.session.username}: quality check skipped: ${error.message}`,
      ))
      .finally(() => {
        if (entry.qualityTask === task) entry.qualityTask = null;
      });

    entry.qualityTask = task;
  }

  async #checkQuality(entry) {
    if (!await hasFreeDisk(
      this.config.downloadDir,
      this.config.liveMinFreeGb ?? 10,
    )) return;

    if (!await hasFreeDisk(
      this.config.dataDir,
      this.config.liveMinFreeGb ?? 10,
    )) return;

    const baseline = await largestRecordedFile(entry.current.stagingDir);
    if (!baseline || baseline.bytes < 512 * 1024) return;

    // TikTok's advertised dimensions are not trusted as proof of quality.
    // Measure the bytes that are actually being recorded.
    let currentQuality;
    try {
      currentQuality = await this.inspect(baseline.path);
    } catch {
      // The ongoing stream may still have an incomplete container header.
      return;
    }

    const candidates = await this.discover(
      entry.session.username,
      this.runtimeConfig,
    );

    if (!Array.isArray(candidates)) return;

    let attempts = 0;

    for (const candidate of candidates) {
      if (this.stopping || entry.session.stopReason || !this.running
        || !entry.current) return;

      // Bound extra bandwidth, disk usage and TikTok requests per check.
      if (attempts >= 2) break;

      if (candidate.id === entry.current.segment.format) continue;

      if (entry.current.segment.format.includes('/')
        && candidate.id === entry.current.segment.format.split('/')[0]) {
        continue;
      }

      if ((entry.qualityFailures.get(candidate.id) ?? 0) > this.now()) {
        continue;
      }

      // Unknown resolutions are worth sampling. Known inferior formats are not.
      const candidatePixels =
        Number(candidate.width) * Number(candidate.height);
      const currentPixels =
        Number(currentQuality.width) * Number(currentQuality.height);

      if (candidatePixels > 0
        && candidatePixels < currentPixels * 0.99) {
        continue;
      }

      if (!await hasFreeDisk(
        this.config.downloadDir,
        this.config.liveMinFreeGb ?? 10,
      )) return;

      if (!await hasFreeDisk(
        this.config.dataDir,
        this.config.liveMinFreeGb ?? 10,
      )) return;

      if (this.stopping || entry.session.stopReason || !this.running) return;

      attempts++;

      let trial;

      try {
        trial = await this.#beginSegment(
          entry,
          candidate.id,
          { testing: true },
        );

        const cutoff = Date.now() + (
          this.qualitySampleMs ??
          Math.max(
            10,
            Number(this.config.liveQualitySampleSeconds || 20),
          ) * 1_000
        );

        let trialExited = false;

        void trial.handle.done.then(() => {
          trialExited = true;
        });

        let measured = null;
        let verifiedAt = 0;
        let initialBytes = 0;

        while (Date.now() < cutoff
          && !this.stopping
          && !entry.session.stopReason) {
          await new Promise((resolve) =>
            setTimeout(resolve, this.qualityPollMs));

          const file = await largestRecordedFile(trial.stagingDir);

          if (!file || file.bytes < 512 * 1024) {
            if (trialExited) break;
            continue;
          }

          if (!verifiedAt) {
            try {
              measured = await this.inspect(file.path);
            } catch {
              // Retry while the candidate stream is still writing.
            }

            if (measured?.width > 0 && measured?.height > 0) {
              verifiedAt = Date.now();
              initialBytes = file.bytes;
            }
          } else if (
            Date.now() - verifiedAt >= this.qualityStableMs
            && file.bytes >= initialBytes + 64 * 1024
          ) {
            // Confirm that the candidate keeps delivering video.
            break;
          }

          if (trialExited) break;
        }

        const finalFile =
          await largestRecordedFile(trial.stagingDir);

        const stable =
          verifiedAt
          && Date.now() - verifiedAt >= this.qualityStableMs
          && finalFile?.bytes >= initialBytes + 64 * 1024
          && !trialExited;

        if (stable
          && measured
          && qualityImproves(measured, currentQuality)
          && !this.stopping
          && !entry.session.stopReason) {
          const previous = entry.current;

          trial.segment.status = 'accepted';
          trial.segment.actualQuality = measured;

          // Recovery must know the new segment is accepted BEFORE
          // the existing working recorder is stopped.
          await this.#writeSession(entry.session);

          entry.current = trial;
          entry.handle = trial.handle;
          entry.trial = null;

          previous.handle.stop();

          this.logger.info?.(
            `[live] QUALITY UPGRADE @${entry.session.username}: `
            + `${currentQuality.width}x${currentQuality.height} -> `
            + `${measured.width}x${measured.height} (${candidate.id}).`,
          );

          return;
        }

        // A failed candidate must never replace or interrupt the
        // existing working recorder.
        entry.qualityFailures.set(
          candidate.id,
          this.now() + 60 * 60_000,
        );

        trial.segment.status = 'rejected';
        await this.#writeSession(entry.session);
      } catch (error) {
        entry.qualityFailures.set(
          candidate.id,
          this.now() + 60 * 60_000,
        );

        if (trial) {
          // Unexpected failures retain the journal entry and bytes
          // so startup recovery can make the safe decision later.
          trial.segment.status = 'testing';
          await this.#writeSession(entry.session).catch(() => {});
        }

        this.logger.warn?.(
          `[live] @${entry.session.username}: `
          + `${candidate.id} test failed: ${error.message}`,
        );
      } finally {
        if (trial && entry.current !== trial) {
          trial.handle.stop();
          await trial.handle.done;

          if (trial.segment.status === 'rejected') {
            await rm(
              trial.stagingDir,
              { recursive: true, force: true },
            );
          }

          if (entry.trial === trial) entry.trial = null;
        }
      }
    }
  }

  #reconnectDelay(entry) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        entry.cancelReconnectDelay = null;
        resolve(true);
      }, Number(this.config.liveReconnectDelayMs ?? 2_000));
      entry.cancelReconnectDelay = () => {
        clearTimeout(timer);
        entry.cancelReconnectDelay = null;
        resolve(false);
      };
    });
  }

  async #tryReconnect(entry, exit, current) {
    const { session } = entry;
    if (!this.config.liveReconnectEnabled || exit?.code !== 0
      || !this.running || this.stopping || session.stopReason) return false;

    if (!await this.#reconnectDelay(entry) || this.stopping || !this.running) return false;

    let live;
    try {
      live = await this.#probeLive(session.username);
    } catch {
      // Network/verification failures are not evidence that the creator went offline.
      session.stopReason = 'reconnect_probe_failed';
      return false;
    }
    if (!live || live.roomId !== session.roomId || this.stopping || !this.running) return false;

    const stableMs = Number(this.config.liveReconnectStableMs ?? 60_000);
    if (this.now() - current.segment.startedAt >= stableMs) entry.shortReconnects = 0;
    if (entry.shortReconnects >= Number(this.config.liveReconnectMaxAttempts ?? 2)) {
      session.stopReason = 'reconnect_limit';
      return false;
    }
    try {
      if (!await hasFreeDisk(this.config.downloadDir, this.config.liveMinFreeGb ?? 10)
        || !await hasFreeDisk(this.config.dataDir, this.config.liveMinFreeGb ?? 10)) {
        session.stopReason = 'low_disk';
        return false;
      }
    } catch {
      session.stopReason = 'reconnect_disk_check_failed';
      return false;
    }
    if (this.stopping || !this.running) return false;

    entry.captureSource = live.source === 'webcast' ? 'webcast' : 'ytdlp';
    entry.streamUrl = live.source === 'webcast' ? live.streamUrl : '';
    try {
      const format = entry.captureSource === 'webcast' ? 'webcast'
        : current.segment.format === 'webcast'
          ? 'flv-hd/flv-hd1/rtmp-pull/hls-hd/hls-pull/best'
          : current.segment.format;
      await this.#beginSegment(entry, format);
      entry.shortReconnects++;
      this.logger.info?.('[live] Reconnected @' + session.username + ' to room ' + session.roomId + '.');
      return true;
    } catch {
      // Preserve a partially created new part when its recorder already wrote bytes.
      const last = session.segments.at(-1);
      if (last && last.index > current.segment.index) {
        const stage = path.join(session.stagingDir, 'segments', String(last.index).padStart(3, '0'));
        const file = await largestRecordedFile(stage).catch(() => null);
        if (!file || file.bytes < 64 * 1024) last.status = 'rejected';
      }
      session.stopReason = 'reconnect_start_failed';
      await this.#writeSession(session).catch(() => {});
      return false;
    }
  }

  async #captureFinished(entry) {
    const { session } = entry;

    try {
      let exit;

      if (entry.current) {
        // Stopping an older segment after a quality switch must never
        // finalize the whole LIVE. Always follow the currently accepted
        // recorder until the actual active capture finishes.
        let current = entry.current;

        while (current) {
          exit = await current.handle.done;

          current.segment.finishedAt = this.now();
          current.segment.exitCode = exit.code;

          await this.#writeSession(session);

          if (entry.current !== current) {
            current = entry.current;
            continue;
          }

          // A candidate may be completing its verification at exactly the
          // same time as the current recorder exits. Let that decision finish
          // before deciding whether the LIVE itself is finished.
          if (entry.qualityTask) {
            await entry.qualityTask;
          }

          if (entry.current !== current) {
            current = entry.current;
            continue;
          }

          if (await this.#tryReconnect(entry, exit, current)) {
            current = entry.current;
            continue;
          }

          break;
        }
      } else {
        // Non-adaptive LIVE recording keeps PR 1's original behavior.
        exit = await entry.handle.done;
      }

      clearInterval(entry.diskTimer);
      clearTimeout(entry.maxTimer);
      clearInterval(entry.qualityTimer);
      clearTimeout(entry.qualityDelay);

      await entry.startedNotification;

      if (this.stopping) {
        // Startup recovery will archive the captured bytes.
        return;
      }

      session.partial =
        exit?.code !== 0 || Boolean(session.stopReason);

      await this.#finalize(session);
    } catch (error) {
      // A remux or database failure must stay recoverable on startup.
      session.phase =
        session.phase === 'finalizing' ? 'finalizing' : 'failed';

      session.error = String(error.message).slice(0, 400);

      await this.#writeSession(session).catch(() => {});

      this.logger.error?.(
        `[live] @${session.username}: recording could not be archived: `
        + `${error.message}. Source kept in ${session.stagingDir}`,
      );
    } finally {
      this.active.delete(session.username.toLowerCase());

      clearInterval(entry.diskTimer);
      clearTimeout(entry.maxTimer);
      clearInterval(entry.qualityTimer);
      clearTimeout(entry.qualityDelay);
    }
  }

  async #finalize(session) {
    if (session.phase === 'complete') return;
    if (session.phase === 'archived') return this.#notifyComplete(session);
    if (Array.isArray(session.segments)) return this.#finalizeSegments(session);
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

  /** Independently archive every accepted segment. Do not use largest-file-wins for upgrades. */
  async #finalizeSegments(session) {
    session.phase = 'finalizing';
    await this.#writeSession(session);
    const folder = path.join(this.config.downloadDir, 'lives', session.username,
      new Date(session.startedAt).toISOString().slice(0, 10));
    await mkdir(folder, { recursive: true });
    const basename = `${session.roomId}_${session.startedAt}`;
    const segments = session.segments.filter((item) => item.status === 'accepted' || item.status === 'testing')
      .sort((a, b) => a.index - b.index);
    const archived = [];
    let missing = false;
    for (const segment of segments) {
      const partNumber = segment.index + 1;
      const basePath = path.join(folder, partNumber === 1 ? basename
        : `${basename}_part${String(partNumber).padStart(2, '0')}`);
      const archiveId = partNumber === 1 ? session.archiveId : `${session.archiveId}_part${String(partNumber).padStart(2, '0')}`;
      const existing = this.store.getLatestFileByPost?.('tiktok', archiveId);
      let dest = existing?.path;
      let media;
      let fileId = existing?.id;
      const stage = path.join(session.stagingDir, 'segments', String(segment.index).padStart(3, '0'));
      if (dest) {
        if (!(await stat(dest).catch(() => null))?.isFile()) {
          throw new Error(`The database references a missing LIVE segment: ${dest}`);
        }
        media = await this.inspect(dest);
      } else {
        // Atomic rename may have succeeded immediately before a crash, before the DB commit.
        for (const ext of ['mp4', 'mkv', 'flv', 'ts', 'webm']) {
          const candidate = `${basePath}.${ext}`;
          if ((await stat(candidate).catch(() => null))?.isFile()) { dest = candidate; break; }
        }
        if (dest) {
          media = await this.inspect(dest);
        } else {
          const source = await largestRecordedFile(stage);
          if (!source || source.bytes < 64 * 1024) {
            missing = true;
            this.logger.warn?.(`[live] @${session.username}: segment ${partNumber} has no usable bytes; preserving session state.`);
            continue;
          }
          try {
            const remuxed = await this.remux(source.path, basePath, { inspect: this.inspect });
            if (this.stopping) return;
            dest = `${basePath}.${remuxed.ext}`;
            await rename(remuxed.tempPath, dest);
            media = await this.inspect(dest);
          } catch (error) {
            missing = true;
            this.logger.warn?.(`[live] @${session.username}: segment ${partNumber} could not be converted: ${error.message}`);
            continue; // Never discard another segment because one is damaged.
          }
        }
        const fileStat = await stat(dest);
        if (this.stopping) return;
        const file = {
          platform: 'tiktok', videoId: archiveId, username: session.username,
          sourceUrl: session.sourceUrl, filePath: dest, filename: path.basename(dest),
          sizeBytes: fileStat.size,
        };
        const data = {
          platform: 'tiktok', remoteId: archiveId,
          canonicalUrl: session.sourceUrl, sourceUrl: session.sourceUrl,
          creatorHandle: session.username,
          title: session.title || `LIVE recording by @${session.username}`,
          mediaType: 'live', publishedAt: session.startedAt,
          durationSeconds: media.duration,
          metadata: { liveRoomId: session.roomId, startedAt: session.startedAt,
            partial: session.partial, stopReason: session.stopReason ?? '',
            recordingPart: partNumber, originalArchiveId: session.archiveId,
            selectedFormat: segment.format, actualQuality: segment.actualQuality ?? null },
          filePath: dest, filename: path.basename(dest), sizeBytes: fileStat.size,
          assets: [{ path: dest, filename: path.basename(dest), sizeBytes: fileStat.size,
            kind: 'video', mimeType: path.extname(dest) === '.mp4' ? 'video/mp4'
              : path.extname(dest) === '.mkv' ? 'video/x-matroska'
                : path.extname(dest) === '.ts' ? 'video/mp2t' : 'video/x-flv',
            width: media.width, height: media.height, durationSeconds: media.duration }],
        };
        ({ fileId } = this.store.createFileWithMedia({ file, media: data }, this.now()));
      }
      const archiveScope = `live:archive:${archiveId}`;
      if (typeof this.store.createLinkToken === 'function'
        && !this.store.getPermanentMonitorDeliveryForFile?.(fileId, { scopeId: archiveScope })) {
        this.store.createLinkToken({
          token: randomBytes(24).toString('hex'), fileId, scopeId: archiveScope,
          deliveryType: 'monitor', expiresAt: 0,
        }, this.now());
      }
      const fileStat = await stat(dest);
      archived.push({ index: segment.index, path: dest, fileId, archiveId,
        sizeBytes: fileStat.size, durationSeconds: media.duration,
        width: media.width, height: media.height });
      segment.archivePath = dest;
      segment.fileId = fileId;
      await this.#writeSession(session); // Save per-segment progress for crash-safe retry.
    }
    if (!archived.length) throw new Error('No recoverable recording was found (no segment had verified video).');
    const primary = archived[0];
    session.fileId = primary.fileId;
    session.primaryArchiveId = primary.archiveId;
    session.archivePath = primary.path;
    session.additionalArchives = archived.slice(1);
    session.sizeBytes = archived.reduce((total, part) => total + part.sizeBytes, 0);
    session.durationSeconds = archived.every((part) => Number.isFinite(part.durationSeconds))
      ? archived.reduce((total, part) => total + part.durationSeconds, 0) : null;
    session.partial = Boolean(session.partial || missing);
    const approvedPartialFinalization =
      Number.isSafeInteger(session.partialFinalizeRequestedAt)
      && session.partialFinalizeRequestedAt >= session.startedAt
      && session.partialFinalizeRequestedAt <= this.now();
    if (missing && !approvedPartialFinalization) {
      // Keep the session retryable until all accepted parts are archived.
      session.phase = 'finalizing';
      await this.#writeSession(session);
      this.logger.warn?.('[live] Some recording segments remain unarchived; retaining staging data for recovery.');
      return;
    }
    session.phase = 'archived';
    await this.#writeSession(session);
    // If any candidate failed verification, retain its staging bytes for manual recovery.
    if (!missing) await rm(session.stagingDir, { recursive: true, force: true });
    this.logger.info?.(`[live] ARCHIVED @${session.username} room ${session.roomId}: `
      + `${archived.length} segment(s), ${session.sizeBytes} bytes${missing ? ' (some raw segments retained)' : ''}.`);
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
      if (['recording', 'finalizing', 'failed'].includes(session.phase)) {
        try {
          session.partial = true;
          await this.#finalize(session);
        } catch (error) {
          // Keep segmented sessions retryable after a transient DB/remux failure.
          // All accepted raw segments or already moved output files remain on disk.
          session.phase = Array.isArray(session.segments) ? 'finalizing' : 'failed';
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
