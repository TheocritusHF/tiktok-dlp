import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LiveMonitor, liveArchiveId } from '../src/live/monitor.js';
import { formatLiveDuration } from '../src/live/discord-notifier.js';
import { largestRecordedFile, liveUrl, parseLiveMetadata } from '../src/live/yt-dlp.js';
import { loadConfig } from '../src/config.js';

const quietLogger = { info() {}, warn() {}, error() {} };
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}
async function until(predicate, timeoutMs = 2_000) {
  const untilTime = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() > untilTime) throw new Error('Timed out waiting for a test condition.');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
function fakeStore() {
  const records = new Map();
  let nextId = 1;
  return {
    records,
    listWatches: () => [{ platform: 'tiktok', username: 'example' }, { platform: 'instagram', username: 'someoneelse' }],
    createFileWithMedia({ file, media }) {
      assert.equal(file.platform, 'tiktok');
      assert.equal(media.mediaType, 'live');
      assert.equal(media.assets.length, 1);
      const id = nextId++;
      records.set(file.videoId, { id, ...file, path: file.filePath, media });
      return { fileId: id };
    },
    getLatestFileByPost(platform, id) { return records.get(id) ?? null; },
  };
}
function fakeRemux() {
  return async (source, base) => {
    const tempPath = `${base}.partial.mp4`;
    const contents = await readFile(source);
    await writeFile(tempPath, contents);
    return { tempPath, ext: 'mp4', media: { width: 1080, height: 1920, duration: 110 } };
  };
}

function config(dir) {
  return {
    dataDir: dir, downloadDir: path.join(dir, 'downloads'),
    livePollSeconds: 120, liveMaxConcurrent: 2,
    liveMinFreeGb: 0, liveMaxHours: 0, liveHandles: [],
    ytdlpCookiesFile: '',
  };
}

test('LIVE metadata requires confirmed live state and numeric room ID', () => {
  assert.equal(parseLiveMetadata({ is_live: false, id: '123456' }), null);
  assert.equal(parseLiveMetadata({ live_status: 'is_upcoming', id: '123456' }), null);
  assert.deepEqual(parseLiveMetadata({ live_status: 'is_live', id: '123456', title: 'Hi' }), {
    roomId: '123456', title: 'Hi',
  });
  assert.throws(() => parseLiveMetadata({ is_live: true, id: '../../bad' }), /room ID/);
  assert.equal(liveUrl('creator_1'), 'https://www.tiktok.com/@creator_1/live');
  assert.throws(() => liveUrl('../bad'));
  assert.equal(liveArchiveId('123456', 1_000), 'live_123456_1000');
  assert.equal(formatLiveDuration(3_661), '1h 1m');
});

test('LIVE is disabled by default and configuration is opt-in', () => {
  const defaults = loadConfig({}, '/tmp');
  assert.equal(defaults.liveEnabled, false);
  assert.equal(defaults.livePollSeconds, 120);
  assert.equal(defaults.liveMinFreeGb, 10);
  const enabled = loadConfig({ LIVE_RECORDING_ENABLED: 'true', LIVE_RECORDING_HANDLES: '@Example, invalid-!,other' }, '/tmp');
  assert.equal(enabled.liveEnabled, true);
  assert.deepEqual(enabled.liveHandles, ['example', 'other']);
});

test('finds the largest capture and ignores yt-dlp metadata files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-files-'));
  try {
    await writeFile(path.join(dir, 'recording.flv'), Buffer.alloc(100));
    await writeFile(path.join(dir, 'recording.ts'), Buffer.alloc(200));
    await writeFile(path.join(dir, 'recording.info.json'), Buffer.alloc(500));
    assert.equal(path.basename((await largestRecordedFile(dir)).path), 'recording.ts');
  } finally { await rm(dir, { force: true, recursive: true }); }
});

test('one detected LIVE records, archives, and sends each alert once', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-success-'));
  const store = fakeStore();
  const finished = deferred();
  const captureStarted = deferred();
  const starts = [];
  const completes = [];
  let probes = 0;
  let captures = 0;
  const worker = new LiveMonitor({
    store, config: config(dir), logger: quietLogger, now: () => 1_780_000_000_000,
    probe: async () => { probes++; return { roomId: '123456789', title: 'Test live' }; },
    capture: (session, _config, { onFirstData }) => {
      captures++;
      void writeFile(path.join(session.stagingDir, 'recording.flv'), Buffer.alloc(128 * 1024))
        .then(() => { onFirstData(); captureStarted.resolve(); });
      return { done: finished.promise, stop: () => finished.resolve({ code: null, signal: 'SIGINT' }) };
    },
    remux: fakeRemux(),
    inspect: async () => ({ width: 1080, height: 1920, duration: 110 }),
    onStart: async (session) => starts.push(session),
    onComplete: async (session) => completes.push(session),
  });
  try {
    await worker.start();
    await captureStarted.promise;
    await worker.runOnce();
    assert.equal(captures, 1, 'does not start a duplicate recording of the same room');
    assert.ok(probes >= 1);
    finished.resolve({ code: 0, signal: null });
    await until(() => completes.length === 1);
    const record = [...store.records.values()][0];
    assert.equal(store.records.size, 1);
    assert.equal(record.media.mediaType, 'live');
    assert.equal(record.media.durationSeconds, 110);
    assert.equal((await stat(record.filePath)).size, 128 * 1024);
    assert.equal(starts.length, 1);
    assert.equal(completes[0].partial, false);
    const sessions = await readdir(path.join(dir, 'live', 'sessions'));
    assert.equal(JSON.parse(await readFile(path.join(dir, 'live', 'sessions', sessions[0]), 'utf8')).phase, 'complete');
  } finally {
    await worker.stop();
    await rm(dir, { force: true, recursive: true });
  }
});

test('restart recovers raw recording after graceful stop without losing data', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-restart-'));
  const store = fakeStore();
  const started = deferred();
  const finished = deferred();
  const common = { store, config: config(dir), logger: quietLogger, now: () => 1_780_000_000_000,
    probe: async () => ({ roomId: '987654321', title: 'Recover me' }),
    remux: fakeRemux(), inspect: async () => ({ width: 720, height: 1280, duration: 55 }) };
  const worker = new LiveMonitor({ ...common,
    capture: (session) => {
      void writeFile(path.join(session.stagingDir, 'recording.flv'), Buffer.alloc(128 * 1024))
        .then(() => started.resolve());
      return { done: finished.promise, stop: () => finished.resolve({ code: null, signal: 'SIGINT' }) };
    },
  });
  try {
    await worker.start();
    await started.promise;
    await worker.stop();
    assert.equal(store.records.size, 0, 'leaves interrupted bytes for startup recovery');
    const recovery = new LiveMonitor({ ...common,
      probe: async () => null,
      capture: () => { throw new Error('Recovery must not start a new capture.'); },
    });
    try {
      await recovery.start();
      await until(() => store.records.size === 1);
      const record = [...store.records.values()][0];
      assert.equal(record.media.metadata.partial, true);
      assert.equal((await stat(record.path)).size, 128 * 1024);
    } finally { await recovery.stop(); }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('a failed completion notification is retried without duplicating the archive', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-retry-'));
  const store = fakeStore();
  const started = deferred();
  const finished = deferred();
  let sendAttempts = 0;
  const worker = new LiveMonitor({
    store, config: config(dir), logger: quietLogger,
    now: () => 1_780_000_000_000,
    probe: async () => ({ roomId: '666666666', title: '' }),
    capture: (session) => {
      void writeFile(path.join(session.stagingDir, 'recording.flv'), Buffer.alloc(128 * 1024))
        .then(() => started.resolve());
      return { done: finished.promise, stop: () => finished.resolve({ code: 0 }) };
    },
    remux: fakeRemux(), inspect: async () => ({ width: 1080, height: 1920, duration: 30 }),
    onComplete: async () => { sendAttempts++; throw new Error('Discord unavailable'); },
  });
  try {
    await worker.start();
    await started.promise;
    finished.resolve({ code: 0 });
    await until(() => sendAttempts === 1);
    assert.equal(store.records.size, 1);
    await worker.stop();
    const recovered = new LiveMonitor({
      store, config: config(dir), logger: quietLogger,
      now: () => 1_780_000_500_000,
      probe: async () => null,
      capture: () => { throw new Error('No new capture expected.'); },
      remux: fakeRemux(), inspect: async () => ({ width: 1080, height: 1920, duration: 30 }),
      onComplete: async () => { sendAttempts++; },
    });
    try {
      await recovered.start();
      assert.equal(sendAttempts, 2);
      assert.equal(store.records.size, 1);
    } finally { await recovered.stop(); }
  } finally { await rm(dir, { force: true, recursive: true }); }
});

test('mixed-case watch names retain their stored identity and whitelist matching is case-insensitive', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-case-'));
  const store = fakeStore();
  store.listWatches = () => [{ platform: 'tiktok', username: 'ExampleCreator' },
    { platform: 'tiktok', username: 'unlisted' }];
  const recordingStarted = deferred();
  const recordingFinished = deferred();
  const checked = [];
  const archived = [];
  const worker = new LiveMonitor({
    store, config: { ...config(dir), liveHandles: ['examplecreator'] }, logger: quietLogger,
    now: () => 1_780_000_000_000,
    probe: async (username) => { checked.push(username); return { roomId: '123456', title: '' }; },
    capture: (session) => {
      void writeFile(path.join(session.stagingDir, 'recording.flv'), Buffer.alloc(128 * 1024))
        .then(() => recordingStarted.resolve());
      return { done: recordingFinished.promise, stop: () => recordingFinished.resolve({ code: 0 }) };
    },
    remux: fakeRemux(), inspect: async () => ({ width: 720, height: 1280, duration: 50 }),
    onComplete: async (session) => archived.push(session),
  });
  try {
    await worker.start();
    await recordingStarted.promise;
    assert.deepEqual(checked, ['ExampleCreator']);
    recordingFinished.resolve({ code: 0 });
    await until(() => archived.length === 1);
    assert.equal(archived[0].username, 'ExampleCreator');
  } finally {
    await worker.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('DB failure after verified file swap can be recovered without raw bytes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-db-recovery-'));
  const store = fakeStore();
  const record = store.createFileWithMedia;
  let failOnce = true;
  store.createFileWithMedia = (input) => {
    if (failOnce) { failOnce = false; throw new Error('Database temporarily unavailable'); }
    return record(input);
  };
  const started = deferred();
  const finished = deferred();
  const cfg = config(dir);
  const setup = {
    store, config: cfg, logger: quietLogger, now: () => 1_780_000_000_000,
    inspect: async () => ({ width: 720, height: 1280, duration: 77 }),
  };
  const worker = new LiveMonitor({ ...setup,
    probe: async () => ({ roomId: '777777777', title: 'Keep this archive' }),
    capture: (session) => {
      void writeFile(path.join(session.stagingDir, 'recording.flv'), Buffer.alloc(128 * 1024))
        .then(() => started.resolve());
      return { done: finished.promise, stop: () => finished.resolve({ code: 0 }) };
    },
    remux: fakeRemux(),
  });
  try {
    await worker.start();
    await started.promise;
    finished.resolve({ code: 0 });
    await until(async () => {
      const files = await readdir(path.join(dir, 'live', 'sessions'));
      if (!files.length) return false;
      const session = JSON.parse(await readFile(path.join(dir, 'live', 'sessions', files[0]), 'utf8'));
      return session.phase === 'finalizing' && Boolean(session.error);
    });
    assert.equal(store.records.size, 0);
    await worker.stop();
    const resumed = new LiveMonitor({ ...setup,
      probe: async () => null,
      capture: () => { throw new Error('No new LIVE expected.'); },
      remux: () => { throw new Error('Already moved file should be reused.'); },
    });
    try {
      await resumed.start();
      assert.equal(store.records.size, 1);
      assert.equal((await stat([...store.records.values()][0].path)).size, 128 * 1024);
    } finally { await resumed.stop(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('archived LIVE has a permanent retention token even if Discord delivery fails', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-retain-'));
  const store = fakeStore();
  const tokens = [];
  store.createLinkToken = (token) => tokens.push(token);
  store.getPermanentMonitorDeliveryForFile = (fileId, { scopeId }) =>
    tokens.find((token) => token.fileId === fileId && token.scopeId === scopeId) ?? null;
  const started = deferred();
  const finished = deferred();
  const worker = new LiveMonitor({
    store, config: config(dir), logger: quietLogger,
    now: () => 1_780_000_000_000,
    probe: async () => ({ roomId: '888888888', title: 'Protect me' }),
    capture: (session) => {
      void writeFile(path.join(session.stagingDir, 'recording.flv'), Buffer.alloc(128 * 1024))
        .then(() => started.resolve());
      return { done: finished.promise, stop: () => finished.resolve({ code: 0 }) };
    },
    remux: fakeRemux(), inspect: async () => ({ width: 720, height: 1280, duration: 45 }),
    onComplete: async () => { throw new Error('Simulated Discord outage'); },
  });
  try {
    await worker.start();
    await started.promise;
    finished.resolve({ code: 0 });
    await until(() => tokens.length === 1);
    assert.equal(tokens[0].expiresAt, 0);
    assert.equal(tokens[0].deliveryType, 'monitor');
    assert.match(tokens[0].scopeId, /^live:archive:/);
    assert.equal(store.records.size, 1);
    assert.equal((await stat([...store.records.values()][0].path)).size, 128 * 1024);
  } finally {
    await worker.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startup recovers an interrupted session with a mixed-case creator handle', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-case-recovery-'));
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const sessionDir = path.join(dir, 'live', 'sessions');
  const stage = path.join(dir, 'live', 'staging', sessionId);
  const timestamp = 1_780_000_000_000;
  const store = fakeStore();
  await mkdir(sessionDir, { recursive: true });
  await mkdir(stage, { recursive: true });
  await writeFile(path.join(stage, 'recording.flv'), Buffer.alloc(128 * 1024));
  await writeFile(path.join(sessionDir, `${sessionId}.json`), JSON.stringify({
    sessionId, username: 'ExampleCreator', roomId: '123456789',
    title: 'Interrupted LIVE', startedAt: timestamp,
    archiveId: liveArchiveId('123456789', timestamp),
    stagingDir: stage, sourceUrl: liveUrl('ExampleCreator'),
    phase: 'recording', fileId: null, partial: false,
  }));
  const worker = new LiveMonitor({
    store, config: config(dir), now: () => timestamp + 1_000,
    logger: quietLogger, probe: async () => null,
    capture: () => { throw new Error('Recovery must not open a new stream.'); },
    remux: fakeRemux(), inspect: async () => ({ width: 720, height: 1280, duration: 120 }),
  });
  try {
    await worker.start();
    assert.equal(store.records.size, 1);
    const record = [...store.records.values()][0];
    assert.equal(record.username, 'ExampleCreator');
    assert.equal(record.media.metadata.partial, true);
    assert.equal((await stat(record.path)).size, 128 * 1024);
  } finally {
    await worker.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
