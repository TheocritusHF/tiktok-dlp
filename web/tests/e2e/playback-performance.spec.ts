import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { SavedVideo } from "../../lib/types";

let directory: string;
let mediaServer: http.Server;
let mediaOrigin: string;
let mediaSize: number;
const mediaGates = new Map<string, Promise<void>>();

interface PlaybackEvent {
  type: string;
  videoId: string;
  at: number;
  readyState: number;
}

declare global {
  interface Window {
    rewindPlaybackEvents: PlaybackEvent[];
    rewindTouchMetrics: {
      touchStarts: number;
      lastTouchEndAt: number;
      scrollEnds: { at: number; position: number }[];
      selections: { at: number; videoId: string }[];
      maxPlayers: number;
      maxCards: number;
    };
  }
}

// Use real H.264/AAC decoding and HTTP ranges; the UI fixtures intentionally mock play().
test.beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "rewind-playback-"));
  const videoPath = path.join(directory, "motion.mp4");
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "20", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "350k", "-maxrate", "400k",
    "-bufsize", "700k", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k",
    "-movflags", "+faststart", videoPath,
  ]);
  mediaSize = (await stat(videoPath)).size;
  mediaServer = http.createServer((request, response) => {
    function sendMedia() {
      if (response.destroyed) return;
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), mediaSize - 1) : mediaSize - 1;
      response.writeHead(range ? 206 : 200, {
        "content-type": "video/mp4",
        "content-length": end - start + 1,
        "accept-ranges": "bytes",
        "access-control-allow-origin": "*",
        "cache-control": "private, max-age=3600",
        ...(range ? { "content-range": `bytes ${start}-${end}/${mediaSize}` } : {}),
      });
      if (request.method === "HEAD") { response.end(); return; }
      const stream = createReadStream(videoPath, { start, end });
      response.on("close", () => stream.destroy());
      stream.pipe(response);
    }
    const gate = mediaGates.get(new URL(request.url || "/", "http://media.test").searchParams.get("gate") || "");
    if (gate) void gate.then(sendMedia);
    else sendMedia();
  });
  await new Promise<void>((resolve) => mediaServer.listen(0, "127.0.0.1", resolve));
  const address = mediaServer.address();
  if (!address || typeof address === "string") throw new Error("Missing media server port");
  mediaOrigin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  mediaServer?.closeAllConnections();
  if (mediaServer) await new Promise<void>((resolve) => mediaServer.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function prepareFeed(page: Page, mediaSuffix = "") {
  await page.addInitScript(() => {
    localStorage.setItem("rewind-feed-hint-seen", "1");
    localStorage.setItem("rewind-feed-muted", "true");
    localStorage.setItem("rewind-feed-autoplay", "true");
    Object.defineProperty(crypto, "getRandomValues", {
      value: (values: Uint32Array) => { values[0] = 1; return values; },
    });
    const events: PlaybackEvent[] = [];
    window.rewindPlaybackEvents = events;
    for (const type of ["play", "playing", "waiting", "error"]) {
      document.addEventListener(type, (event) => {
        if (!(event.target instanceof HTMLVideoElement)) return;
        events.push({
          type,
          videoId: event.target.closest<HTMLElement>("[data-video-id]")?.dataset.videoId || "",
          at: performance.now(),
          readyState: event.target.readyState,
        });
      }, true);
    }
  });
  const videos: SavedVideo[] = Array.from({ length: 36 }, (_, index) => ({
    id: String(index + 1), creatorId: "motion", username: "motion", displayName: "Motion",
    title: `Motion ${index + 1}`, description: "", tags: [], mediaType: "video",
    videoUrl: `${mediaOrigin}/media/${index + 1}${mediaSuffix}`, thumbnailUrl: "", accent: "#65d6b4",
    savedAt: "2026-09-11T00:00:00.000Z", savedAtLabel: "Today", duration: "0:20",
    sizeBytes: mediaSize, sizeLabel: "1 MB", sourceUrl: "https://www.tiktok.com/@motion/video/1",
  }));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const body = url.pathname === "/api/videos" ? { items: videos, nextCursor: null }
      : url.pathname === "/api/creators" ? [{ id: "motion", username: "motion", displayName: "Motion", initials: "M", accent: "#65d6b4", videoCount: 36, storageLabel: "36 MB", lastSynced: "Today", status: "healthy", enabled: true }]
      : url.pathname === "/api/bookmarks" ? { fileIds: [] } : {};
    await route.fulfill({ json: body });
  });
}

async function constrainConnection(page: Page, browserName: string) {
  if (browserName === "chromium") {
    const session = await page.context().newCDPSession(page);
    await session.send("Network.enable");
    await session.send("Network.emulateNetworkConditions", {
      offline: false, latency: 80, downloadThroughput: 375_000, uploadThroughput: 125_000,
    });
    await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }
}

test("real audio keeps the chosen sound state across swipes and remounted players", async ({ page }) => {
  await prepareFeed(page);
  await page.goto("/");
  const active = page.locator('[data-feed-card][aria-hidden="false"]');
  const video = active.locator("video");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.2);
  const original = await video.elementHandle();
  const scroller = page.locator("#feed-video-list");
  const height = await scroller.evaluate(element => element.clientHeight);
  for (const muted of [false, true]) {
    await page.getByRole("button", { name: /^Show controls for / }).click();
    await page.getByRole("button", { name: muted ? "Mute videos" : "Turn sound on", exact: true }).click();
    for (const index of [1, 0, 12, 11, 0]) {
      await scroller.evaluate((element: HTMLElement, index) => {
        element.style.scrollSnapType = "none";
        element.scrollTop = element.clientHeight * index;
      }, index);
      await expect(active).toHaveCSS("top", `${index * height}px`);
      await expect(video).toHaveJSProperty("muted", muted);
      const startedAt = await video.evaluate((element: HTMLVideoElement) => element.currentTime);
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(startedAt + 0.2);
      await expect(video).toHaveJSProperty("paused", false);
      await expect(video).toHaveJSProperty("error", null);
      await expect.poll(() => page.locator('[data-feed-card][aria-hidden="true"] video').evaluateAll(videos => (
        videos.every(element => (element as HTMLVideoElement).paused)
      ))).toBe(true);
    }
    expect(await page.evaluate(() => localStorage.getItem("rewind-feed-muted"))).toBe(String(muted));
    expect(await video.evaluate((element, first) => element === first, original)).toBe(false);
  }
});

test("real video plays, seeks, and retains its buffer across swipes on a constrained connection", async ({ page, browserName }, testInfo) => {
  await prepareFeed(page);
  await constrainConnection(page, browserName);
  const navigationStarted = Date.now();
  // This seed places video 6 at index 12, where both swipes recycle the window.
  await page.goto("/?video=6");
  const active = page.locator('[data-feed-card][aria-hidden="false"] video');
  await expect(active).toBeAttached();
  await expect(active.locator("..")).toHaveAttribute("data-video-id", "6");
  const firstId = await active.evaluate((video) => video.closest("[data-video-id]")?.getAttribute("data-video-id"));
  const firstCard = page.locator(`[data-video-id="${firstId}"]`);
  const first = firstCard.locator("video");
  await expect.poll(() => first.evaluate((video: HTMLVideoElement) => video.currentTime), { timeout: 12_000 }).toBeGreaterThan(0.5);
  const startMs = Date.now() - navigationStarted;
  await expect.poll(() => first.evaluate((video: HTMLVideoElement) => video.videoWidth)).toBe(360);
  await expect.poll(() => first.evaluate((video: HTMLVideoElement) => (
    video.buffered.length ? video.buffered.end(0) > 5
      // Linux WebKit can expose an empty TimeRanges after finishing the download.
      : video.readyState === HTMLMediaElement.HAVE_ENOUGH_DATA && video.networkState === HTMLMediaElement.NETWORK_IDLE
  ))).toBe(true);
  const firstHandle = await first.elementHandle();
  const firstTime = await first.evaluate((video: HTMLVideoElement) => video.currentTime);
  await firstCard.evaluate((card) => card.nextElementSibling?.scrollIntoView({ behavior: "instant" }));
  await expect.poll(() => active.evaluate((video) => video.closest("[data-video-id]")?.getAttribute("data-video-id"))).not.toBe(firstId);
  await expect.poll(() => active.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0.2);
  await expect(first).toHaveJSProperty("paused", true);
  await firstCard.evaluate((card) => card.scrollIntoView({ behavior: "instant" }));
  await expect(active.locator("..")).toHaveAttribute("data-video-id", firstId!);
  await expect.poll(() => first.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(firstTime);
  await expect.poll(() => page.locator('[data-feed-card][aria-hidden="true"] video').evaluateAll((videos) => (
    videos.every((video) => (video as HTMLVideoElement).paused)
  ))).toBe(true);
  expect(await first.evaluate((video, previous) => video === previous, firstHandle)).toBe(true);

  await first.evaluate((video: HTMLVideoElement) => { video.currentTime = 12; });
  await expect.poll(() => first.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(12.2);
  await expect(first).toHaveJSProperty("error", null);
  expect(await page.locator("video").count()).toBeLessThanOrEqual(3);
  expect(await page.locator("[data-feed-card]").count()).toBeLessThanOrEqual(7);
  await testInfo.attach("playback-metrics", { body: JSON.stringify({ startMs, decodedFrames: await first.evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames) }), contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("playing.png") });
});

test("a real clip plays through its duration and presents the next loop promptly", async ({ page, browserName }, testInfo) => {
  test.setTimeout(45_000);
  await prepareFeed(page);
  await constrainConnection(page, browserName);
  await page.goto("/");
  const active = page.locator('[data-feed-card][aria-hidden="false"] video');
  await expect.poll(() => active.evaluate((video: HTMLVideoElement) => video.currentTime), { timeout: 12_000 }).toBeGreaterThan(0.2);
  const metrics = await active.evaluate((video: HTMLVideoElement) => new Promise<{
    duration: number; lastFrameBeforeEnd: number; restartMs: number; endedEvents: number;
  }>((resolve, reject) => {
    let endedAt = 0;
    let endedEvents = 0;
    let lastTime = video.currentTime;
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      reject(new Error("The clip did not complete and restart within its duration"));
    }, (video.duration + 5) * 1000);
    video.addEventListener("ended", () => { endedEvents += 1; endedAt = performance.now(); });
    video.requestVideoFrameCallback(function onFrame(at, frame) {
      if (finished) return;
      if (frame.mediaTime < lastTime - 0.5) {
        finished = true;
        clearTimeout(timer);
        if (!endedAt) reject(new Error(`Playback jumped backward before ending: ${lastTime} to ${frame.mediaTime}`));
        else resolve({ duration: video.duration, lastFrameBeforeEnd: lastTime, restartMs: at - endedAt, endedEvents });
        return;
      }
      lastTime = frame.mediaTime;
      video.requestVideoFrameCallback(onFrame);
    });
  }));
  expect(metrics.endedEvents).toBe(1);
  expect(metrics.lastFrameBeforeEnd).toBeGreaterThan(metrics.duration - 0.5);
  expect(metrics.restartMs).toBeLessThan(1000);
  await expect(active).toHaveJSProperty("paused", false);
  await expect(active).toHaveJSProperty("error", null);
  await testInfo.attach("loop-metrics", { body: JSON.stringify(metrics), contentType: "application/json" });
});

test("requests playback before delayed media metadata arrives and starts when released", async ({ page }, testInfo) => {
  let releaseMedia!: () => void;
  mediaGates.set("startup", new Promise<void>((resolve) => { releaseMedia = resolve; }));
  try {
    await prepareFeed(page, "?gate=startup");
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const active = page.locator('[data-feed-card][aria-hidden="false"] video');
    await expect(active).toBeAttached();
    // A real play event while headers are held catches preload-before-play deadlocks.
    await expect.poll(() => page.evaluate(() => window.rewindPlaybackEvents
      .some((event) => event.type === "play" && event.readyState === 0))).toBe(true);
    await expect(active).toHaveJSProperty("paused", false);
    await expect(active).toHaveJSProperty("readyState", 0);
    const releasedAt = await page.evaluate(() => performance.now());
    releaseMedia();
    await expect.poll(() => active.evaluate((video: HTMLVideoElement) => video.currentTime), { timeout: 8_000 }).toBeGreaterThan(0.2);
    await expect(active).toHaveJSProperty("videoWidth", 360);
    await expect(active).toHaveJSProperty("error", null);
    const events = await page.evaluate(() => window.rewindPlaybackEvents);
    const playing = events.find((event) => event.type === "playing" && event.at >= releasedAt);
    expect(playing).toBeDefined();
    await testInfo.attach("delayed-startup-metrics", {
      body: JSON.stringify({ releaseToPlayingMs: playing!.at - releasedAt, events }),
      contentType: "application/json",
    });
  } finally {
    releaseMedia();
    mediaGates.delete("startup");
  }
});

test("real decoding resumes after rapid forward and reverse swipes across the virtual window", async ({ page, browserName }, testInfo) => {
  test.setTimeout(45_000);
  await prepareFeed(page);
  await constrainConnection(page, browserName);
  await page.goto("/");
  const activeCard = page.locator('[data-feed-card][aria-hidden="false"]');
  const activeVideo = activeCard.locator("video");
  await expect.poll(() => activeVideo.evaluate((video: HTMLVideoElement) => video.currentTime), { timeout: 12_000 }).toBeGreaterThan(0.2);
  const scroller = page.locator("#feed-video-list");
  const metrics: { direction: string; settleToPlayingMs: number; videoId: string }[] = [];

  for (const [direction, positions] of [
    ["forward", [1, 2, 3, 4, 5, 6, 7, 8, 9]],
    ["reverse", [8, 7, 6, 5, 4, 3, 2, 1, 0]],
  ] as const) {
    const settledAt = await scroller.evaluate(async (element: HTMLElement, indices) => {
      element.style.scrollSnapType = "none";
      for (const index of indices.slice(0, -1)) {
        element.scrollTop = element.clientHeight * index;
        await new Promise((resolve) => window.setTimeout(resolve, 80));
      }
      const settledAt = performance.now();
      element.scrollTop = element.clientHeight * indices[indices.length - 1];
      return settledAt;
    }, positions);
    const finalIndex = positions[positions.length - 1];
    await expect.poll(() => activeCard.evaluate((card) => {
      const parent = card.parentElement!;
      return Math.round((card.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop) / parent.clientHeight);
    })).toBe(finalIndex);
    const videoId = (await activeCard.getAttribute("data-video-id"))!;
    await expect.poll(() => page.evaluate(({ id, after }) => window.rewindPlaybackEvents
      .some((event) => event.videoId === id && event.type === "playing" && event.at >= after), { id: videoId, after: settledAt }), { timeout: 10_000 }).toBe(true);
    const previousTime = await activeVideo.evaluate((video: HTMLVideoElement) => video.currentTime);
    await expect.poll(() => activeVideo.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(previousTime + 0.15);
    await expect(activeVideo).toHaveJSProperty("videoWidth", 360);
    await expect(activeVideo).toHaveJSProperty("error", null);
    await expect(activeVideo).toHaveJSProperty("paused", false);
    await expect.poll(() => page.locator('[data-feed-card][aria-hidden="true"] video').evaluateAll((videos) => (
      videos.every((video) => (video as HTMLVideoElement).paused)
    ))).toBe(true);
    expect(await page.locator("video").count()).toBeLessThanOrEqual(3);
    expect(await page.locator("[data-feed-card]").count()).toBeLessThanOrEqual(7);
    const playing = await page.evaluate(({ id, after }) => window.rewindPlaybackEvents
      .find((event) => event.videoId === id && event.type === "playing" && event.at >= after), { id: videoId, after: settledAt });
    metrics.push({ direction, videoId, settleToPlayingMs: playing!.at - settledAt });
    await scroller.evaluate((element: HTMLElement) => { element.style.scrollSnapType = ""; });
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop / element.clientHeight)).toBe(finalIndex);
    await page.screenshot({ path: testInfo.outputPath(`${direction}-playing.png`) });
  }
  await testInfo.attach("rapid-swipe-metrics", { body: JSON.stringify(metrics), contentType: "application/json" });
});

test("native touch swipes skip and reverse with scroll snap and real video decoding", async ({ page, browserName, isMobile }, testInfo) => {
  test.skip(browserName !== "chromium" || !isMobile, "CDP touch injection requires mobile Chromium");
  test.setTimeout(45_000);
  await prepareFeed(page);
  await constrainConnection(page, browserName);
  await page.goto("/?video=6");
  const activeCard = page.locator('[data-feed-card][aria-hidden="false"]');
  const activeVideo = activeCard.locator("video");
  const scroller = page.locator("#feed-video-list");
  await expect(activeCard).toHaveAttribute("data-video-id", "6");
  await expect.poll(() => activeVideo.evaluate((video: HTMLVideoElement) => video.currentTime), { timeout: 12_000 }).toBeGreaterThan(0.2);
  await expect.poll(() => scroller.evaluate((element) => getComputedStyle(element).scrollSnapType)).toBe("y mandatory");
  await scroller.evaluate((element) => {
    const metrics: Window["rewindTouchMetrics"] = {
      touchStarts: 0, lastTouchEndAt: 0, scrollEnds: [], selections: [],
      maxPlayers: 0, maxCards: 0,
    };
    window.rewindTouchMetrics = metrics;
    element.addEventListener("touchstart", (event) => {
      if (event.isTrusted) metrics.touchStarts++;
    }, { passive: true });
    element.addEventListener("touchend", (event) => {
      if (event.isTrusted) metrics.lastTouchEndAt = performance.now();
    }, { passive: true });
    element.addEventListener("scrollend", () => {
      metrics.scrollEnds.push({ at: performance.now(), position: element.scrollTop / element.clientHeight });
    });
    const recordSelection = () => {
      const videoId = element.querySelector<HTMLElement>('[data-feed-card][aria-hidden="false"]')?.dataset.videoId || "";
      if (videoId && metrics.selections.at(-1)?.videoId !== videoId) {
        metrics.selections.push({ at: performance.now(), videoId });
      }
      metrics.maxPlayers = Math.max(metrics.maxPlayers, element.querySelectorAll("video").length);
      metrics.maxCards = Math.max(metrics.maxCards, element.querySelectorAll("[data-feed-card]").length);
    };
    new MutationObserver(recordSelection).observe(element, {
      subtree: true, childList: true, attributes: true, attributeFilter: ["aria-hidden"],
    });
    recordSelection();
  });
  const bounds = (await scroller.boundingBox())!;
  const session = await page.context().newCDPSession(page);
  const measurements = [];
  let previousIndex = await scroller.evaluate((element) => Math.round(element.scrollTop / element.clientHeight));

  for (const direction of ["forward", "reverse"] as const) {
    const batchStartedAt = await page.evaluate(() => performance.now());
    const startY = bounds.y + bounds.height * (direction === "forward" ? 0.8 : 0.2);
    const endY = bounds.y + bounds.height * (direction === "forward" ? 0.2 : 0.8);
    // Inject browser touch input, leaving the compositor, fling, and snap behavior intact.
    for (let swipe = 0; swipe < 4; swipe++) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart", touchPoints: [{ x: bounds.x + bounds.width / 2, y: startY, id: 1 }],
      });
      for (let step = 1; step <= 6; step++) {
        await session.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: bounds.x + bounds.width / 2, y: startY + (endY - startY) * step / 6, id: 1 }],
        });
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      if (swipe < 3) await new Promise((resolve) => setTimeout(resolve, 80));
    }
    await expect.poll(() => page.evaluate(() => {
      const metrics = window.rewindTouchMetrics;
      return metrics.scrollEnds.some((event) => event.at >= metrics.lastTouchEndAt);
    })).toBe(true);
    const settled = await page.evaluate(() => window.rewindTouchMetrics.scrollEnds.at(-1)!);
    const finalIndex = Math.round(settled.position);
    expect(Math.abs(settled.position - finalIndex)).toBeLessThan(0.01);
    if (direction === "forward") expect(finalIndex).toBeGreaterThan(previousIndex + 1);
    else expect(finalIndex).toBeLessThan(previousIndex - 1);
    await expect.poll(() => activeCard.evaluate((card) => {
      const parent = card.parentElement!;
      return Math.round((card.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop) / parent.clientHeight);
    })).toBe(finalIndex);
    const videoId = (await activeCard.getAttribute("data-video-id"))!;
    await expect.poll(() => page.evaluate(({ id, after }) => window.rewindPlaybackEvents
      .some((event) => event.videoId === id && event.type === "playing" && event.at >= after), { id: videoId, after: batchStartedAt }), { timeout: 10_000 }).toBe(true);
    const decodedFrames = await activeVideo.evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames);
    await expect.poll(() => activeVideo.evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(decodedFrames + 2);
    await expect(activeVideo).toHaveJSProperty("videoWidth", 360);
    await expect(activeVideo).toHaveJSProperty("paused", false);
    await expect(activeVideo).toHaveJSProperty("error", null);
    await expect.poll(() => page.locator('[data-feed-card][aria-hidden="true"] video').evaluateAll((videos) => (
      videos.every((video) => (video as HTMLVideoElement).paused)
    ))).toBe(true);
    const timing = await page.evaluate(({ id, after, settledAt }) => {
      const selected = window.rewindTouchMetrics.selections.findLast((event) => event.videoId === id && event.at >= after)!;
      const playing = window.rewindPlaybackEvents.find((event) => event.videoId === id && event.type === "playing" && event.at >= selected.at)!;
      return {
        selectionAfterSettleMs: Math.max(0, selected.at - settledAt),
        selectionToPlayingMs: Math.max(0, playing.at - selected.at),
        settleToPlayingMs: Math.max(0, playing.at - settledAt),
      };
    }, { id: videoId, after: batchStartedAt, settledAt: settled.at });
    measurements.push({ direction, fromIndex: previousIndex, toIndex: finalIndex, videoId, ...timing });
    previousIndex = finalIndex;
  }
  const input = await page.evaluate(() => window.rewindTouchMetrics);
  expect(input.touchStarts).toBe(8);
  expect(input.maxPlayers).toBeLessThanOrEqual(3);
  expect(input.maxCards).toBeLessThanOrEqual(7);
  await expect.poll(() => scroller.evaluate((element) => getComputedStyle(element).scrollSnapType)).toBe("y mandatory");
  await testInfo.attach("native-touch-playback-metrics", {
    body: JSON.stringify({ measurements, input }), contentType: "application/json",
  });
  await page.screenshot({ path: testInfo.outputPath("native-touch-reverse-playing.png") });
});
