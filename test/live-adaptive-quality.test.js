import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LiveMonitor, liveArchiveId } from '../src/live/monitor.js';
import { qualityImproves, rankLiveFormats } from '../src/live/adaptive-quality.js';
import { sendLiveArchived } from '../src/live/discord-notifier.js';
import { loadConfig } from '../src/config.js';

const quiet = { info() {}, warn() {}, error() {} };
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate, timeoutMs = 3_000) {
  const end = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error('Timed out waiting for adaptive test condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function fakeStore() {
  const records = new Map();
  const tokens = [];
  let next = 1;
  return {
    records, tokens,
    listWatches: () => [{ platform: 'tiktok', username: 'Example' }],
    createFileWithMedia({ file, media }) {
      assert.equal(media.assets.length, 1);
      assert.equal(media.mediaType, 'live');
      const id = next++;
      records.set(file.videoId, { id, ...file, path: file.filePath, media });
      return { fileId: id };
    },
    getLatestFileByPost(_platform, id) { return records.get(id) ?? null; },
    createLinkToken(token) { tokens.push(token); },
    getPermanentMonitorDeliveryForFile(fileId, { scopeId }) {
      return tokens.find((token) => token.fileId === fileId && token.scopeId === scopeId) ?? null;
    },
  };
}
function cfg(dir) {
  return { dataDir: dir, downloadDir: path.join(dir, 'downloads'),
    liveHandles: [], liveMinFreeGb: 0, livePollSeconds: 120, liveMaxConcurrent: 2,
    liveMaxHours: 0, ytdlpCookiesFile: '', liveAdaptiveQualityEnabled: true,
    liveQualityCheckMinutes: 15, liveQualitySampleSeconds: 10 };
}
function fakeRemux() {
  return async (source, base) => {
    const tempPath = `${base}.partial.mp4`;
    await writeFile(tempPath, await readFile(source));
    return { tempPath, ext: 'mp4', media: { width: 640, height: 1280, duration: 30 } };
  };
}
function fakeCapture(captures, { emptyTrial = false } = {}) {
  return (session, config, { onFirstData, format }) => {
    const ended = deferred();
    const item = { session, format, stopped: false,
      done: ended.promise,
      stop() { if (item.stopped) return; item.stopped = true; ended.resolve({ code: 0 }); },
    };
    captures.push(item);
    void (async () => {
      if (emptyTrial && captures.length > 1) {
        ended.resolve({ code: 1 });
        return;
      }
      const recording = path.join(session.stagingDir, 'recording.flv');
      await writeFile(recording, Buffer.alloc(600 * 1024));
      onFirstData();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await (await import('node:fs/promises')).appendFile(recording, Buffer.alloc(100 * 1024));
    })();
    return item;
  };
}
const inspect = async (filePath) => filePath.includes('/001/')
  ? { width: 1080, height: 1920, fps: 30, bitrate: 2_000_000, duration: 30 }
  : { width: 640, height: 1280, fps: 25, bitrate: 1_000_000, duration: 30 };
const discovery = async () => [{ id: 'hls-higher', width: 1080, height: 1920, tbr: 2000 }];

function workerParams(dir, store, extra = {}) {
  return { config: cfg(dir), store, logger: quiet,
    qualityStartDelayMs: 10, qualityPollMs: 10, qualitySampleMs: 150, qualityStableMs: 20,
    probe: async () => ({ roomId: '123456789', title: 'Test' }),
    remux: fakeRemux(), inspect, discover: discovery, ...extra };
}

test('adaptive quality defaults off, and discovery filters audio-only formats', () => {
  const c = loadConfig({}, '/tmp');
  assert.equal(c.liveAdaptiveQualityEnabled, false);
  assert.equal(loadConfig({ LIVE_ADAPTIVE_QUALITY_ENABLED: 'true' }, '/tmp').liveAdaptiveQualityEnabled, true);
  const candidates = rankLiveFormats([
    { format_id: 'flv-ao', width: 0, height: 0 },
    { format_id: 'hls-high', width: 1080, height: 1920 },
    { format_id: 'flv-hd', width: 640, height: 1280 },
    { format_id: '../../evil', width: 9999, height: 9999 },
  ]);
  assert.deepEqual(candidates.map((c) => c.id), ['hls-high', 'flv-hd']);
  assert.equal(qualityImproves({ width: 1080, height: 1920 }, { width: 640, height: 1280 }), true);
  assert.equal(qualityImproves({ width: 640, height: 1280 }, { width: 640, height: 1280 }), false);
  assert.equal(qualityImproves({ width: 640, height: 1280, fps: 30 }, { width: 640, height: 1280, fps: 25 }), true);
});

test('record immediately, verify better format in parallel, switch and archive BOTH parts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-adaptive-switch-'));
  const store = fakeStore();
  const captures = [], starts = [], completes = [];
  const worker = new LiveMonitor(workerParams(dir, store, {
    capture: fakeCapture(captures),
    onStart: async (session) => starts.push(session),
    onComplete: async (session) => completes.push(session),
  }));
  try {
    await worker.start();
    await until(() => captures.length === 2);
    assert.match(captures[0].format, /\/best$/, 'unknown LIVE format IDs still have a recording fallback');
    assert.equal(captures[0].stopped, false, 'working recorder stays running while testing');
    await until(() => captures[0].stopped);
    assert.equal(starts.length, 1, 'start notification only once');
    assert.equal(captures[1].stopped, false, 'higher-quality process is still active');
    captures[1].stop();
    await until(() => completes.length === 1);
    assert.equal(store.records.size, 2, 'both earlier and upgraded footage are indexed');
    assert.equal(store.tokens.length, 2, 'both parts have permanent retention tokens');
    assert.equal(completes[0].additionalArchives.length, 1);
    assert.equal(completes[0].partial, false);
    for (const record of store.records.values()) assert.equal((await stat(record.path)).size, 700 * 1024);
    const sessionFiles = await readdir(path.join(dir, 'live', 'sessions'));
    const journal = JSON.parse(await readFile(path.join(dir, 'live', 'sessions', sessionFiles[0]), 'utf8'));
    assert.equal(journal.phase, 'complete');
    assert.equal(journal.segments.filter((item) => item.status === 'accepted').length, 2);
  } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('failed candidate never interrupts the working recorder', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-adaptive-fail-'));
  const store = fakeStore(), captures = [], completes = [];
  const worker = new LiveMonitor(workerParams(dir, store, {
    capture: fakeCapture(captures, { emptyTrial: true }),
    onComplete: async (session) => completes.push(session),
  }));
  try {
    await worker.start();
    await until(() => captures.length > 1);
    await until(() => captures[1].stopped);
    assert.equal(captures[0].stopped, false, 'failure must not stop the initial stream');
    captures[0].stop();
    await until(() => completes.length === 1);
    assert.equal(store.records.size, 1);
    assert.equal(completes[0].additionalArchives.length, 0);
  } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('restart recovery retains all journaled quality segments and sends one completion', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-adaptive-recovery-'));
  const store = fakeStore();
  const sid = '00000000-0000-4000-8000-000000000009';
  const startedAt = 1_780_000_000_000;
  const root = path.join(dir, 'live', 'staging', sid);
  const sessionDir = path.join(dir, 'live', 'sessions');
  await mkdir(sessionDir, { recursive: true });
  for (const part of ['000', '001']) {
    await mkdir(path.join(root, 'segments', part), { recursive: true });
    await writeFile(path.join(root, 'segments', part, 'recording.flv'), Buffer.alloc(128 * 1024));
  }
  const session = { sessionId: sid, username: 'Example', roomId: '123456789', title: 'Hi',
    startedAt, archiveId: liveArchiveId('123456789', startedAt), stagingDir: root,
    sourceUrl: 'https://www.tiktok.com/@Example/live', phase: 'recording', fileId: null,
    partial: false, segments: [{ index: 0, status: 'accepted', format: 'flv-hd', startedAt },
      { index: 1, status: 'accepted', format: 'hls-higher', startedAt: startedAt + 20_000 }] };
  await writeFile(path.join(sessionDir, `${sid}.json`), JSON.stringify(session));
  const completes = [];
  const worker = new LiveMonitor(workerParams(dir, store, {
    now: () => startedAt + 60_000, probe: async () => null,
    capture: () => { throw new Error('Recovery may not open a new stream.'); },
    onComplete: async (value) => completes.push(value),
  }));
  try {
    await worker.start();
    assert.equal(store.records.size, 2);
    assert.equal(store.tokens.length, 2);
    assert.equal(completes.length, 1);
    assert.equal(completes[0].partial, true);
  } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('multi-part Discord completion includes a link to every archived part', async () => {
  const sent = [];
  await sendLiveArchived({ client: { channels: { fetch: async () => ({ send: async (message) => sent.push(message) }) } },
    channelId: 'abc', session: { username: 'Example', sizeBytes: 120, durationSeconds: 30,
      sourceUrl: 'https://www.tiktok.com/@Example/live', additionalArchives: [{ index: 1 }] },
    publicUrl: 'https://example.com/part1', additionalUrls: ['https://example.com/part2'],
  });
  assert.match(sent[0].content, /part1/);
  assert.match(sent[0].content, /part2/);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
});

test('equivalent quality is rejected while the existing LIVE capture continues', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-adaptive-equal-'));
  const store = fakeStore(), captures = [], completes = [];
  const sameQuality = async () => ({ width: 640, height: 1280, fps: 25, bitrate: 1_000_000, duration: 30 });
  const worker = new LiveMonitor(workerParams(dir, store, {
    capture: fakeCapture(captures), inspect: sameQuality,
    onComplete: async (session) => completes.push(session),
  }));
  try {
    await worker.start();
    await until(() => captures.length === 2);
    await until(() => captures[1].stopped);
    assert.equal(captures[0].stopped, false);
    captures[0].stop();
    await until(() => completes.length === 1);
    assert.equal(store.records.size, 1);
    assert.equal(store.tokens.length, 1);
  } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('a transient database error on part two recovers without duplicating part one', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-adaptive-db-'));
  const store = fakeStore();
  const originalCreate = store.createFileWithMedia;
  let failed = false;
  store.createFileWithMedia = (args) => {
    if (args.file.videoId.endsWith('_part02') && !failed) {
      failed = true;
      throw new Error('Transient database error');
    }
    return originalCreate(args);
  };
  const sid = '00000000-0000-4000-8000-000000000099';
  const startedAt = 1_780_000_000_000;
  const stagingDir = path.join(dir, 'live', 'staging', sid);
  const sessionDir = path.join(dir, 'live', 'sessions');
  await mkdir(sessionDir, { recursive: true });
  for (const part of ['000', '001']) {
    await mkdir(path.join(stagingDir, 'segments', part), { recursive: true });
    await writeFile(path.join(stagingDir, 'segments', part, 'recording.flv'), Buffer.alloc(128 * 1024));
  }
  await writeFile(path.join(sessionDir, `${sid}.json`), JSON.stringify({
    sessionId: sid, username: 'Example', roomId: '123456789', title: 'DB retry',
    startedAt, archiveId: liveArchiveId('123456789', startedAt), stagingDir,
    sourceUrl: 'https://www.tiktok.com/@Example/live', phase: 'recording',
    partial: false, segments: [{ index: 0, status: 'accepted', format: 'flv-hd' },
      { index: 1, status: 'accepted', format: 'hls-higher' }],
  }));
  const complete = [];
  const setup = { now: () => startedAt + 60_000, probe: async () => null,
    capture: () => { throw new Error('Recovery must not start a new capture.'); },
    onComplete: async (session) => complete.push(session) };
  try {
    const first = new LiveMonitor(workerParams(dir, store, setup));
    await first.start();
    assert.equal(failed, true);
    assert.equal(store.records.size, 1);
    assert.equal(complete.length, 0);
    await first.stop();
    const journal = JSON.parse(await readFile(path.join(sessionDir, `${sid}.json`), 'utf8'));
    assert.equal(journal.phase, 'finalizing');
    const restarted = new LiveMonitor(workerParams(dir, store, setup));
    try {
      await restarted.start();
      assert.equal(store.records.size, 2, 'recovery creates the missing row only');
      assert.equal(store.tokens.length, 2);
      assert.equal(complete.length, 1);
    } finally { await restarted.stop(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('startup retries an accepted adaptive segment missing during first finalization', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-adaptive-missing-'));
  const store = fakeStore();
  const sid = '00000000-0000-4000-8000-0000000000aa';
  const startedAt = 1_780_000_000_000;
  const stagingDir = path.join(dir, 'live', 'staging', sid);
  const sessionDir = path.join(dir, 'live', 'sessions');
  const completes = [];

  await mkdir(sessionDir, { recursive: true });
  for (const part of ['000', '001']) {
    await mkdir(path.join(stagingDir, 'segments', part), { recursive: true });
  }
  await writeFile(
    path.join(stagingDir, 'segments', '000', 'recording.flv'),
    Buffer.alloc(128 * 1024),
  );

  await writeFile(path.join(sessionDir, `${sid}.json`), JSON.stringify({
    sessionId: sid, username: 'Example', roomId: '123456789',
    title: 'Recover missing segment', startedAt,
    archiveId: liveArchiveId('123456789', startedAt),
    stagingDir, sourceUrl: 'https://www.tiktok.com/@Example/live',
    phase: 'recording', partial: false,
    segments: [
      { index: 0, status: 'accepted', format: 'flv-hd' },
      { index: 1, status: 'accepted', format: 'flv-hd1' },
    ],
  }));

  const createWorker = (timestamp) => new LiveMonitor(workerParams(dir, store, {
    now: () => timestamp,
    probe: async () => null,
    capture: () => { throw new Error('Recovery must not start another recording.'); },
    onComplete: async (session) => completes.push(session),
  }));

  let first;
  let resumed;
  try {
    first = createWorker(startedAt + 60_000);
    await first.start();

    assert.equal(store.records.size, 1, 'the available segment must be preserved');
    assert.equal(completes.length, 0, 'completion must wait for the missing segment');

    await first.stop();
    first = null;

    await writeFile(
      path.join(stagingDir, 'segments', '001', 'recording.flv'),
      Buffer.alloc(128 * 1024),
    );

    resumed = createWorker(startedAt + 120_000);
    await resumed.start();

    assert.equal(store.records.size, 2, 'restart must archive the recovered segment');
    assert.equal(store.tokens.length, 2);
    assert.equal(completes.length, 1, 'completion must be sent exactly once');
    assert.equal(completes[0].additionalArchives.length, 1);
  } finally {
    if (resumed) await resumed.stop();
    if (first) await first.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
test('explicit partial finalization preserves raw files and delivers available parts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-partial-finalize-'));
  const store = fakeStore();
  const sid = '00000000-0000-4000-8000-0000000000bb';
  const startedAt = 1_780_000_000_000;
  const stagingDir = path.join(dir, 'live', 'staging', sid);
  const sessionDir = path.join(dir, 'live', 'sessions');
  const rawMissingPart = path.join(stagingDir, 'segments', '001', 'recording.flv');
  const completes = [];

  await mkdir(sessionDir, { recursive: true });
  for (const part of ['000', '001']) {
    await mkdir(path.join(stagingDir, 'segments', part), { recursive: true });
  }

  await writeFile(
    path.join(stagingDir, 'segments', '000', 'recording.flv'),
    Buffer.alloc(128 * 1024),
  );
  await writeFile(rawMissingPart, Buffer.alloc(1024));

  await writeFile(path.join(sessionDir, `${sid}.json`), JSON.stringify({
    sessionId: sid, username: 'Example', roomId: '123456789',
    title: 'Partially recoverable LIVE', startedAt,
    archiveId: liveArchiveId('123456789', startedAt),
    stagingDir, sourceUrl: 'https://www.tiktok.com/@Example/live',
    phase: 'finalizing', partial: true,
    partialFinalizeRequestedAt: startedAt + 30_000,
    segments: [
      { index: 0, status: 'accepted', format: 'flv-hd' },
      { index: 1, status: 'accepted', format: 'flv-hd1' },
    ],
  }));

  const worker = new LiveMonitor(workerParams(dir, store, {
    now: () => startedAt + 60_000,
    probe: async () => null,
    capture: () => { throw new Error('Recovery must not start another recording.'); },
    onComplete: async (session) => completes.push(session),
  }));

  try {
    await worker.start();

    assert.equal(store.records.size, 1, 'archive the usable recording');
    assert.equal(store.tokens.length, 1, 'retain the archived recording');
    assert.equal(completes.length, 1, 'notify once after explicit approval');
    assert.equal(completes[0].partial, true);
    assert.equal((await stat(rawMissingPart)).size, 1024,
      'preserve the incomplete raw recording');

    const saved = JSON.parse(
      await readFile(path.join(sessionDir, `${sid}.json`), 'utf8'),
    );
    assert.equal(saved.phase, 'complete');
  } finally {
    await worker.stop();
    await rm(dir, { recursive: true, force: true });
  }
});