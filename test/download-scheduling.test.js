import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDownloadService } from '../src/download/service.js';
import { createPlatformRegistry, tiktokAdapter } from '../src/platforms/index.js';
import { createStore } from '../src/state/store.js';

const probeRegistry = createPlatformRegistry([{
  ...tiktokAdapter,
  capabilities: { ...tiktokAdapter.capabilities, probeBeforeDownload: true },
}]);

test('a resolved download finishes before later metadata probes occupy its worker', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'download-pipeline-'));
  const store = createStore(path.join(dir, 'state.db'));
  const firstGate = Promise.withResolvers();
  const secondGate = Promise.withResolvers();
  const events = [];
  const requests = [];
  let firstResult;
  try {
    const service = createDownloadService({
      config: { downloadDir: dir, maxConcurrentDownloads: 1 }, store,
      platformRegistry: probeRegistry,
      metadataFetcher: async (sourceUrl) => {
        const id = new URL(sourceUrl).pathname.split('/').at(-1);
        events.push(`probe:${id}`);
        if (id === '123') await firstGate.promise;
        if (id === '456') await secondGate.promise;
        return { id, uploader: 'creator' };
      },
      downloader: async (sourceUrl, { metadata }) => {
        events.push(`download:${metadata.id}`);
        const filePath = path.join(dir, `${metadata.id}.mp4`);
        await writeFile(filePath, 'video');
        return { filePath, videoId: metadata.id };
      },
    });
    requests.push(service.request('https://www.tiktok.com/@creator/video/123')
      .then(result => { firstResult = result; }));
    await waitFor(() => events.length === 1);
    requests.push(service.request('https://www.tiktok.com/@creator/video/456'));
    requests.push(service.request('https://www.tiktok.com/@creator/video/789'));
    const releasedAt = performance.now();
    firstGate.resolve();
    await waitFor(() => firstResult != null);
    assert.equal(firstResult.videoId, '123');
    assert.deepEqual(events.slice(0, 2), ['probe:123', 'download:123']);
    t.diagnostic(`First delivery completed ${(performance.now() - releasedAt).toFixed(1)} ms after its metadata, while the later probe was still held.`);
    secondGate.resolve();
    await Promise.all(requests);
    await service.waitForIdle();
    assert.deepEqual(events, ['probe:123', 'download:123', 'probe:456', 'download:456', 'probe:789', 'download:789']);
    assert.equal(service.status().workQueued, 0);
  } finally {
    firstGate.resolve();
    secondGate.resolve();
    await Promise.allSettled(requests);
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const concurrency of [1, 2]) {
  test(`different short links share one download with ${concurrency} worker(s)`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'download-alias-pipeline-'));
    const store = createStore(path.join(dir, 'state.db'));
    let probes = 0;
    let downloads = 0;
    let active = 0;
    let peak = 0;
    const track = async (work) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 5));
        return await work();
      } finally { active -= 1; }
    };
    try {
      const service = createDownloadService({
        config: { downloadDir: dir, maxConcurrentDownloads: concurrency }, store,
        metadataFetcher: () => track(() => { probes += 1; return { id: '123', uploader: 'creator' }; }),
        downloader: () => track(async () => {
          downloads += 1;
          const filePath = path.join(dir, '123.mp4');
          await writeFile(filePath, 'video');
          return { filePath, videoId: '123' };
        }),
      });
      const results = await Promise.all([
        service.request('https://vm.tiktok.com/ZMfirst/'),
        service.request('https://vm.tiktok.com/ZMsecond/'),
      ]);
      await service.waitForIdle();
      assert.equal(probes, 2);
      assert.equal(downloads, 1);
      assert.ok(peak <= concurrency);
      assert.equal(results[0].fileId, results[1].fileId);
      assert.notEqual(results[0].token, results[1].token);
      assert.equal(service.status().active, 0);
      assert.equal(service.status().identityInFlight, 0);
      assert.equal(service.status().inFlightAssets, 0);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const failureStage of ['probe', 'download']) {
  test(`a failed ${failureStage} releases the pipeline and permits a later retry`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'download-pipeline-retry-'));
    const store = createStore(path.join(dir, 'state.db'));
    let failing = true;
    try {
      const service = createDownloadService({
        config: { downloadDir: dir, maxConcurrentDownloads: 1 }, store,
        platformRegistry: probeRegistry,
        metadataFetcher: async () => {
          if (failing && failureStage === 'probe') throw new Error('Probe failed');
          return { id: '123', uploader: 'creator' };
        },
        downloader: async () => {
          if (failing && failureStage === 'download') throw new Error('Download failed');
          const filePath = path.join(dir, '123.mp4');
          await writeFile(filePath, 'video');
          return { filePath, videoId: '123' };
        },
      });
      const sourceUrl = 'https://www.tiktok.com/@creator/video/123';
      const results = await Promise.allSettled([service.request(sourceUrl), service.request(sourceUrl)]);
      assert.ok(results.every(result => result.status === 'rejected'));
      await service.waitForIdle();
      failing = false;
      const result = await service.request(sourceUrl);
      await service.waitForIdle();
      assert.equal(result.videoId, '123');
      assert.equal(store.stats().fileCount, 1);
      assert.equal(service.status().active, 0);
      assert.equal(service.status().identityInFlight, 0);
      assert.equal(service.status().inFlightAssets, 0);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for a delivery.');
}
