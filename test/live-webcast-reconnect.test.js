import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LiveMonitor } from '../src/live/monitor.js';
import {
  captureWebcastLive, parseWebcastProfile, parseWebcastRoom,
  probeWebcastLive, safeWebcastStreamUrl,
} from '../src/live/webcast.js';
import { loadConfig } from '../src/config.js';

const quiet = { info() {}, warn() {}, error() {} };
const streamUrl = 'https://pull-flv-f1.tiktokcdn.com/live/room.flv?test_marker=synthetic-private-value';
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate, timeoutMs = 2_000) {
  const end = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error('Timed out waiting for LIVE test.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function store() {
  const records = new Map();
  let id = 0;
  return {
    records,
    listWatches: () => [{ platform: 'tiktok', username: 'example' }],
    createFileWithMedia({ file, media }) {
      records.set(file.videoId, { ...file, media, id: ++id, path: file.filePath });
      return { fileId: id };
    },
    getLatestFileByPost(_platform, key) { return records.get(key) ?? null; },
  };
}
function config(dir, extra = {}) {
  return {
    dataDir: dir, downloadDir: path.join(dir, 'downloads'),
    livePollSeconds: 120, liveMaxConcurrent: 2, liveMinFreeGb: 0,
    liveMaxHours: 0, liveHandles: [], ytdlpCookiesFile: '',
    liveReconnectDelayMs: 1, liveReconnectMaxAttempts: 2,
    liveReconnectStableMs: 60_000, ...extra,
  };
}
function captureRecorder(captures) {
  return (session, _config, { onFirstData, streamUrl: selected }) => {
    const finished = deferred();
    const item = { selected, session, done: finished.promise,
      finish(code = 0) { finished.resolve({ code }); },
      stop() { finished.resolve({ code: null, signal: 'SIGINT' }); },
    };
    captures.push(item);
    void writeFile(path.join(session.stagingDir, 'recording.mkv'), Buffer.alloc(128 * 1024))
      .then(() => onFirstData());
    return item;
  };
}
const remux = async (source, base) => {
  const tempPath = base + '.partial.mp4';
  await writeFile(tempPath, await readFile(source));
  return { tempPath, ext: 'mp4', media: { width: 720, height: 1280, duration: 10 } };
};
const inspect = async () => ({ width: 720, height: 1280, duration: 10 });

test('webcast parsing verifies creator, active room, and HTTPS CDN stream', () => {
  const html = '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">'
    + JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.user-detail': {
      userInfo: { user: { uniqueId: 'Example', roomId: '123456789' } },
    } } }) + '</script>';
  assert.equal(parseWebcastProfile(html, 'example'), '123456789');
  assert.throws(() => parseWebcastProfile(html, 'another'), /creator/);
  assert.throws(() => parseWebcastProfile('<html>captcha</html>', 'example'), /verifiable/);
  const payload = { data: {
    id: '123456789', ownerInfo: { uniqueId: 'Example' }, status: 2,
    title: 'A live', stream_url: { flv_pull_url: { hd: streamUrl } },
  } };
  assert.equal(parseWebcastRoom(payload, 'example', '123456789').streamUrl, streamUrl);
  const ranked = { data: { ...payload.data,
    stream_url: { flv_pull_url: {
      SD1: 'https://pull-flv-f1.tiktokcdn.com/low.flv',
      ORIGION: 'https://pull-flv-f1.tiktokcdn.com/best.flv',
    } },
  } };
  assert.match(parseWebcastRoom(ranked, 'example', '123456789').streamUrl, /best\.flv/);
  assert.equal(parseWebcastRoom({ data: { ...payload.data, status: 4 } }, 'example', '123456789'), null);
  assert.throws(() => parseWebcastRoom(payload, 'example', '999999999'), /room/);
  assert.throws(() => parseWebcastRoom(payload, 'someoneelse', '123456789'), /owner/);
  assert.equal(safeWebcastStreamUrl('http://pull-flv-f1.tiktokcdn.com/live'), '');
  assert.equal(safeWebcastStreamUrl('https://127.0.0.1/live'), '');
  assert.equal(safeWebcastStreamUrl('https://tiktokcdn.com.evil.test/live'), '');
  assert.equal(safeWebcastStreamUrl('https://user:pass@pull-flv-f1.tiktokcdn.com/live'), '');
});

test('webcast probe uses fixed TikTok endpoints and returns a fresh room stream', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) {
      return new Response('<script id="SIGI_STATE">'
        + JSON.stringify({ LiveRoom: { liveRoomUserInfo: { user: {
          uniqueId: 'example', roomId: '123456789',
        } } } }) + '</script>');
    }
    return Response.json({ data: {
      room_id: '123456789', status: 2, owner: { display_id: 'example' },
      stream_url: { hls_pull_url: 'https://pull-hls-f1.ttlivecdn.com/room.m3u8' },
    } });
  };
  const live = await probeWebcastLive('example', {}, { fetchImpl });
  assert.equal(live.roomId, '123456789');
  assert.equal(live.source, 'webcast');
  assert.equal(requests[0].url, 'https://www.tiktok.com/@example');
  assert.match(requests[1].url, /^https:\/\/webcast\.tiktok\.com\/webcast\/room\/info\?/);
  assert.equal(requests[0].options.redirect, 'error');
});

test('an incomplete profile may use the verified LIVE page, but not a mismatched owner', async () => {
  const calls = [];
  const livePage = '<script id="SIGI_STATE">'
    + JSON.stringify({ LiveRoom: { liveRoomUserInfo: { user: {
      uniqueId: 'example', roomId: '123456789',
    } } } }) + '</script>';
  const fetchImpl = async (url) => {
    calls.push(url);
    if (calls.length === 1) return new Response('<html>No hydrated user data</html>');
    if (calls.length === 2) return new Response(livePage);
    return Response.json({ data: {
      id: '123456789', status: 2, ownerInfo: { uniqueId: 'example' },
      stream_url: { flv_pull_url: { HD1: streamUrl } },
    } });
  };
  assert.equal((await probeWebcastLive('example', {}, { fetchImpl })).roomId, '123456789');
  assert.equal(calls[1], 'https://www.tiktok.com/@example/live');
  let attempts = 0;
  const mismatched = async () => {
    attempts++;
    return new Response('<script id="SIGI_STATE">'
      + JSON.stringify({ LiveRoom: { liveRoomUserInfo: { user: {
        uniqueId: 'another', roomId: '123456789',
      } } } }) + '</script>');
  };
  await assert.rejects(probeWebcastLive('example', {}, { fetchImpl: mismatched }), /creator/);
  assert.equal(attempts, 1, 'a different owner must not trigger further requests');
});

test('oversized and invalid webcast responses fail without exposing response data', async () => {
  await assert.rejects(
    probeWebcastLive('example', {}, { fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) }),
    /size limit/,
  );
  let requestCount = 0;
  const fetchImpl = async () => {
    if (++requestCount === 1) {
      return new Response('<script id="SIGI_STATE">'
        + JSON.stringify({ LiveRoom: { liveRoomUserInfo: { user: {
          uniqueId: 'example', roomId: '123456789',
        } } } }) + '</script>');
    }
    return new Response('{ "broken": "synthetic-private-value"');
  };
  await assert.rejects(
    probeWebcastLive('example', {}, { fetchImpl }),
    (error) => !error.message.includes('synthetic-private-value') && /invalid or unavailable/.test(error.message),
  );
});

test('FFmpeg copy recorder keeps signed URLs out of completion and logs', async () => {
  let args;
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => {};
  const handle = captureWebcastLive(
    { username: 'example', stagingDir: '/tmp/unused' }, {}, {
      streamUrl,
      logger: { warn: () => assert.fail('Signed URL leaked into a log') },
      spawnImpl: (_bin, received) => { args = received; return child; },
    },
  );
  assert.equal(args[args.indexOf('-i') + 1], streamUrl);
  assert.deepEqual(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2), ['-c', 'copy']);
  child.stderr.write('Failed input ' + streamUrl);
  child.emit('close', 0, null);
  assert.equal(JSON.stringify(await handle.done).includes('synthetic-private-value'), false);
  assert.throws(() => captureWebcastLive(
    { username: 'example', stagingDir: '/tmp/unused' }, {}, {
      streamUrl, spawnImpl: () => { throw new Error(streamUrl); },
    },
  ), (error) => error.message === 'FFmpeg could not start.');
});

test('false-offline yt-dlp uses webcast fallback without journaling signed URLs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-webcast-'));
  const archive = store();
  const captures = [];
  const worker = new LiveMonitor({
    store: archive, config: config(dir, { liveWebcastFallbackEnabled: true }),
    logger: quiet, now: () => 1_780_000_000_000,
    probe: async () => null,
    webcastProbe: async () => ({ roomId: '123456789', source: 'webcast', streamUrl }),
    webcastCapture: captureRecorder(captures), remux, inspect,
  });
  try {
    await worker.start();
    await until(() => captures.length === 1);
    assert.equal(captures[0].selected, streamUrl);
    await until(async () => (await stat(path.join(captures[0].session.stagingDir, 'recording.mkv')).catch(() => null))?.size > 0);
    captures[0].finish();
    await until(() => archive.records.size === 1);
    const journals = (await readdir(path.join(dir, 'live', 'sessions'))).filter((name) => name.endsWith('.json'));
    assert.equal((await readFile(path.join(dir, 'live', 'sessions', journals[0]), 'utf8')).includes('synthetic-private-value'), false);
  } finally {
    await worker.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('webcast fallback coexists with adaptive mode without sampling yt-dlp formats', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-webcast-adaptive-'));
  const archive = store();
  const captures = [];
  const worker = new LiveMonitor({
    store: archive, config: config(dir, {
      liveWebcastFallbackEnabled: true, liveAdaptiveQualityEnabled: true,
    }),
    logger: quiet, now: () => 1_780_000_000_000,
    qualityStartDelayMs: 1, qualityPollMs: 1,
    probe: async () => null,
    webcastProbe: async () => ({ roomId: '123456789', source: 'webcast', streamUrl }),
    webcastCapture: captureRecorder(captures),
    discover: async () => assert.fail('webcast fallback has no yt-dlp quality trials'),
    remux, inspect,
  });
  try {
    await worker.start();
    await until(() => captures.length === 1);
    await until(async () => (await stat(path.join(captures[0].session.stagingDir, 'recording.mkv')).catch(() => null))?.size > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(captures.length, 1);
    captures[0].finish();
    await until(() => archive.records.size === 1);
  } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('two short same-room reconnects archive all parts and then stop partial', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-reconnect-'));
  const archive = store();
  const captures = [], completions = [];
  let clock = 1_780_000_000_000;
  const worker = new LiveMonitor({
    store: archive, config: config(dir, { liveReconnectEnabled: true }),
    logger: quiet, now: () => clock,
    probe: async () => ({ roomId: '123456789', title: 'Same room' }),
    capture: captureRecorder(captures), remux, inspect,
    onComplete: async (session) => completions.push(session),
  });
  try {
    await worker.start();
    for (let index = 0; index < 3; index++) {
      await until(() => captures.length === index + 1);
      await until(async () => (await stat(path.join(captures[index].session.stagingDir, 'recording.mkv')).catch(() => null))?.size > 0);
      clock += 5_000;
      captures[index].finish();
    }
    await until(() => completions.length === 1);
    assert.equal(archive.records.size, 3);
    assert.equal(completions[0].stopReason, 'reconnect_limit');
    assert.equal(completions[0].partial, true);
    assert.equal(completions[0].additionalArchives.length, 2);
  } finally {
    await worker.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('different room ends current session; shutdown cancels a pending reconnect', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-room-change-'));
  const archive = store();
  const captures = [], completions = [];
  let probes = 0;
  const worker = new LiveMonitor({
    store: archive, config: config(dir, { liveReconnectEnabled: true, liveReconnectDelayMs: 1 }),
    logger: quiet, now: () => 1_780_000_000_000,
    probe: async () => ({ roomId: ++probes === 1 ? '123456789' : '987654321' }),
    capture: captureRecorder(captures), remux, inspect,
    onComplete: async (session) => completions.push(session),
  });
  try {
    await worker.start();
    await until(() => captures.length === 1);
    await until(async () => (await stat(path.join(captures[0].session.stagingDir, 'recording.mkv')).catch(() => null))?.size > 0);
    captures[0].finish();
    await until(() => completions.length === 1);
    assert.equal(captures.length, 1);
    assert.equal(completions[0].partial, false);
  } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }

  const secondDir = await mkdtemp(path.join(os.tmpdir(), 'live-stop-reconnect-'));
  const secondArchive = store();
  const secondCaptures = [];
  const second = new LiveMonitor({
    store: secondArchive, config: config(secondDir, { liveReconnectEnabled: true, liveReconnectDelayMs: 10_000 }),
    logger: quiet, now: () => 1_780_000_000_000,
    probe: async () => ({ roomId: '123456789' }),
    capture: captureRecorder(secondCaptures), remux, inspect,
  });
  try {
    await second.start();
    await until(() => secondCaptures.length === 1);
    secondCaptures[0].finish();
    await until(() => second.active.get('example')?.cancelReconnectDelay);
    await second.stop();
    assert.equal(secondCaptures.length, 1);
    assert.equal(secondArchive.records.size, 0);
  } finally { await second.stop(); await rm(secondDir, { recursive: true, force: true }); }
});

test('a stable segment resets the short reconnect count', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-stable-reconnect-'));
  const captures = [], completions = [];
  let clock = 1_780_000_000_000;
  const worker = new LiveMonitor({
    store: store(), config: config(dir, { liveReconnectEnabled: true, liveReconnectMaxAttempts: 1 }),
    logger: quiet, now: () => clock,
    probe: async () => ({ roomId: '123456789' }),
    capture: captureRecorder(captures), remux, inspect,
    onComplete: async (session) => completions.push(session),
  });
  try {
    await worker.start();
    for (const [index, duration] of [5_000, 65_000, 5_000].entries()) {
      await until(() => captures.length === index + 1);
      await until(async () => (await stat(path.join(captures[index].session.stagingDir, 'recording.mkv')).catch(() => null))?.size > 0);
      clock += duration;
      captures[index].finish();
    }
    await until(() => completions.length === 1);
    assert.equal(captures.length, 3);
    assert.equal(completions[0].stopReason, 'reconnect_limit');
    assert.equal(completions[0].additionalArchives.length, 2);
  } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('inconclusive recheck and recorder failure preserve footage without reconnecting', async () => {
  for (const failedRecorder of [false, true]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'live-failed-reconnect-'));
    const captures = [], completions = [];
    let probes = 0;
    const worker = new LiveMonitor({
      store: store(), config: config(dir, { liveReconnectEnabled: true }),
      logger: quiet, now: () => 1_780_000_000_000,
      probe: async () => {
        if (++probes > 1) throw new Error('Temporary network failure');
        return { roomId: '123456789' };
      },
      capture: captureRecorder(captures), remux, inspect,
      onComplete: async (session) => completions.push(session),
    });
    try {
      await worker.start();
      await until(() => captures.length === 1);
      await until(async () => (await stat(path.join(captures[0].session.stagingDir, 'recording.mkv')).catch(() => null))?.size > 0);
      captures[0].finish(failedRecorder ? 1 : 0);
      await until(() => completions.length === 1);
      assert.equal(captures.length, 1);
      assert.equal(completions[0].partial, true);
      assert.equal(completions[0].stopReason, failedRecorder ? undefined : 'reconnect_probe_failed');
      assert.equal(probes, failedRecorder ? 1 : 2);
    } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
  }
});

test('shutdown stops a recorder created during the stop race', async () => {
  for (const segmented of [false, true]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'live-stop-race-'));
    let stopPromise;
    let stopCalls = 0;
    let worker;
    const finished = deferred();
    worker = new LiveMonitor({
      store: store(), config: config(dir, { liveReconnectEnabled: segmented }),
      logger: quiet, now: () => 1_780_000_000_000,
      probe: async () => ({ roomId: '123456789' }),
      capture: () => {
        stopPromise = worker.stop();
        return {
          done: finished.promise,
          stop() { stopCalls++; finished.resolve({ code: null, signal: 'SIGINT' }); },
        };
      },
      remux, inspect,
    });
    try {
      await worker.start();
      await until(() => stopCalls === 1);
      await stopPromise;
      assert.equal(stopCalls, 1);
    } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
  }
});

test('webcast and reconnect settings are optional and bounded', () => {
  const defaults = loadConfig({}, '/tmp');
  assert.equal(defaults.liveWebcastFallbackEnabled, false);
  assert.equal(defaults.liveReconnectEnabled, false);
  const enabled = loadConfig({
    LIVE_WEBCAST_FALLBACK_ENABLED: 'true', LIVE_RECONNECT_ENABLED: 'true',
    LIVE_RECONNECT_DELAY_SECONDS: '2', LIVE_RECONNECT_MAX_ATTEMPTS: '2',
    LIVE_RECONNECT_STABLE_SECONDS: '60',
  }, '/tmp');
  assert.equal(enabled.liveWebcastFallbackEnabled, true);
  assert.equal(enabled.liveReconnectEnabled, true);
  assert.equal(enabled.liveReconnectDelayMs, 2_000);
  assert.equal(enabled.liveReconnectMaxAttempts, 2);
  assert.equal(enabled.liveReconnectStableMs, 60_000);
});
