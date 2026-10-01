import { test, expect } from "./fixtures/archive";

test("a browser playback rejection cannot erase an explicit sound choice", async ({ page }) => {
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    let started = false;
    HTMLMediaElement.prototype.play = function () {
      if (!started) {
        this.dataset.authorized = "true";
        started = true;
      }
      if (!this.muted && this.dataset.authorized !== "true") {
        return Promise.reject(new DOMException("User gesture required", "NotAllowedError"));
      }
      return play.call(this);
    };
  });
  await page.goto("/");
  const active = page.locator('[data-feed-card][aria-hidden="false"]');
  await expect(active.locator("video")).toHaveJSProperty("paused", false);
  await page.getByRole("button", { name: /^Show controls for / }).click();
  await page.getByRole("button", { name: "Turn sound on", exact: true }).click();
  const nextId = await active.evaluate(card => {
    const next = card.nextElementSibling as HTMLElement;
    next.scrollIntoView({ behavior: "instant", block: "start" });
    return next.dataset.videoId;
  });
  await expect(active).toHaveAttribute("data-video-id", nextId!);
  await expect(active.locator("video")).toHaveJSProperty("muted", false);
  await expect(active.getByRole("button", { name: "Retry video", exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("rewind-feed-muted"))).toBe("false");
  await active.locator("video").evaluate((video: HTMLVideoElement) => { video.dataset.authorized = "true"; });
  await active.getByRole("button", { name: "Retry video", exact: true }).click();
  await expect(active.locator("video")).toHaveJSProperty("muted", false);
  await expect(active.locator("video")).toHaveJSProperty("paused", false);
});

test("startup autoplay fallback preserves the remembered sound preference", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("rewind-feed-muted", "false");
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (!this.muted) return Promise.reject(new DOMException("User gesture required", "NotAllowedError"));
      return play.call(this);
    };
  });
  await page.goto("/");
  const video = page.locator('[data-feed-card][aria-hidden="false"] video');
  await expect(video).toHaveJSProperty("paused", false);
  await expect(video).toHaveJSProperty("muted", true);
  expect(await page.evaluate(() => localStorage.getItem("rewind-feed-muted"))).toBe("false");
});

test("a late playback rejection cannot undo a newer sound gesture", async ({ page }) => {
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (!this.muted && !this.dataset.heldSoundRequest) {
        this.dataset.heldSoundRequest = "true";
        return new Promise<void>((resolve, reject) => {
          this.addEventListener("reject-stale-play", () => reject(new DOMException("User gesture required", "NotAllowedError")), { once: true });
        });
      }
      return play.call(this);
    };
  });
  await page.goto("/");
  const active = page.locator('[data-feed-card][aria-hidden="false"]');
  await expect(active.locator("video")).toHaveJSProperty("paused", false);
  await page.getByRole("button", { name: /^Show controls for / }).click();
  await page.getByRole("button", { name: "Turn sound on", exact: true }).click();
  await expect(active.locator("video")).toHaveAttribute("data-held-sound-request", "true");
  await page.getByRole("button", { name: "Mute videos", exact: true }).click();
  await page.getByRole("button", { name: "Turn sound on", exact: true }).click();
  await active.locator("video").dispatchEvent("reject-stale-play");
  await expect(active.locator("video")).toHaveJSProperty("muted", false);
  await expect(active.locator("video")).toHaveJSProperty("paused", false);
  await expect(active.getByRole("button", { name: "Retry video", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("rewind-feed-muted"))).toBe("false");
});

test("only an active, visible, unpaused clip restarts after ending", async ({ page }) => {
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      this.dataset.playCalls = String(Number(this.dataset.playCalls || "0") + 1);
      return play.call(this);
    };
  });
  await page.goto("/");
  const active = page.locator('[data-feed-card][aria-hidden="false"] video');
  await expect(active).toHaveJSProperty("paused", false);
  await expect(active).toHaveJSProperty("loop", false);
  await active.evaluate((video) => { video.dataset.playCalls = "0"; });
  await active.dispatchEvent("ended");
  await expect(active).toHaveAttribute("data-play-calls", "1");

  const inactive = page.locator('[data-feed-card][aria-hidden="true"] video').first();
  await expect(inactive).toBeAttached();
  await inactive.evaluate((video) => { video.dataset.playCalls = "0"; });
  await inactive.dispatchEvent("ended");
  await expect(inactive).toHaveAttribute("data-play-calls", "0");
  await expect(inactive).toHaveJSProperty("paused", true);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(active).toHaveJSProperty("paused", true);
  await active.evaluate((video) => { video.dataset.playCalls = "0"; });
  await active.dispatchEvent("ended");
  await expect(active).toHaveAttribute("data-play-calls", "0");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(active).toHaveJSProperty("paused", false);
  await page.keyboard.press("Space");
  await expect(active).toHaveJSProperty("paused", true);
  await active.evaluate((video) => { video.dataset.playCalls = "0"; });
  await active.dispatchEvent("ended");
  await expect(active).toHaveAttribute("data-play-calls", "0");
});

test("an unresolved media load offers retry instead of buffering indefinitely", async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 0 });
    HTMLMediaElement.prototype.play = function () {
      this.dataset.playRequested = "true";
      return new Promise(() => {});
    };
  });
  await page.goto("/");
  const card = page.locator('[data-feed-card][aria-hidden="false"]');
  const video = card.locator("video");
  await expect(video).toHaveAttribute("data-play-requested", "true");
  await page.clock.fastForward(16_000);
  await expect(card.getByRole("alert")).toHaveText("Video is taking too long to load. Tap retry.");
  await expect(card.getByRole("button", { name: "Retry video", exact: true })).toBeVisible();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  await video.evaluate((element: HTMLVideoElement) => {
    element.load = function () { this.dataset.reloaded = "true"; };
    element.play = function () {
      this.dispatchEvent(new Event("playing"));
      return Promise.resolve();
    };
  });
  await card.getByRole("button", { name: "Retry video", exact: true }).click();
  await expect(video).toHaveAttribute("data-reloaded", "true");
  await expect(card.getByRole("alert")).toHaveCount(0);
});

for (const started of [false, true]) {
  test(`${started ? "rebuffering" : "initial buffering"} keeps its deadline until a video frame arrives`, async ({ page }) => {
    await page.clock.install();
    if (!started) {
      await page.addInitScript(() => { HTMLVideoElement.prototype.requestVideoFrameCallback = () => 1; });
    }
    await page.goto("/");
    const card = page.locator('[data-feed-card][aria-hidden="false"]');
    const video = card.locator("video");
    await expect(video).toHaveJSProperty("paused", false);
    if (started) {
      await page.clock.fastForward(100);
      await expect(card.locator("img")).toHaveClass(/videoPosterHidden/);
      await video.evaluate((element: HTMLVideoElement) => {
        Object.defineProperty(element, "requestVideoFrameCallback", { value: () => 1 });
      });
      await page.getByRole("button", { name: /^Show controls for / }).click();
    }
    for (let cycle = 0; cycle < 4; cycle += 1) {
      await video.dispatchEvent("waiting");
      await page.clock.fastForward(2_000);
      await video.dispatchEvent("playing");
      await page.clock.fastForward(2_000);
    }
    await expect(card.getByRole("button", { name: "Retry video", exact: true })).toBeVisible();
    await expect(card.getByRole("alert")).toHaveText("Video is taking too long to load. Tap retry.");
    await expect(video).toHaveJSProperty("paused", true);
  });
}

test("presented frames clear a waiting event even without another playing event", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  const card = page.locator('[data-feed-card][aria-hidden="false"]');
  const video = card.locator("video");
  await expect(video).toHaveJSProperty("paused", false);
  await page.clock.fastForward(100);
  await video.dispatchEvent("waiting");
  await page.clock.fastForward(1000);
  await page.clock.fastForward(16_000);
  await expect(video).toHaveJSProperty("paused", false);
  await expect(card.getByRole("button", { name: "Retry video", exact: true })).toHaveCount(0);
  await expect(card.getByRole("alert")).toHaveCount(0);
});

test("returning to an audio-only clip does not treat media readiness as a video frame", async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    HTMLVideoElement.prototype.requestVideoFrameCallback = () => 1;
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 0 });
  });
  await page.goto("/");
  const active = page.locator('[data-feed-card][aria-hidden="false"]');
  const originalId = await active.getAttribute("data-video-id");
  const original = page.locator(`[data-video-id="${originalId}"] video`);
  await expect.poll(() => original.evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  const nextId = await active.evaluate((card) => {
    const next = card.nextElementSibling as HTMLElement;
    next.scrollIntoView({ behavior: "instant", block: "start" });
    return next.dataset.videoId;
  });
  await expect(active).toHaveAttribute("data-video-id", nextId!);
  await expect(original).toHaveJSProperty("paused", true);
  await original.locator("..").evaluate((card) => card.scrollIntoView({ behavior: "instant", block: "start" }));
  await expect(active).toHaveAttribute("data-video-id", originalId!);
  await expect(original).toHaveJSProperty("paused", false);
  await page.clock.fastForward(16_000);
  await expect(active.getByRole("button", { name: "Retry video", exact: true })).toBeVisible();
});

test("feed preserves the previous player's buffer and bounds speculative loading", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, "buffered", {
      configurable: true,
      get() { return { length: 1, start: () => 0, end: () => 30 }; },
    });
  });
  await page.goto("/");
  const active = page.locator('[data-feed-card][aria-hidden="false"]');
  const initialId = await active.getAttribute("data-video-id");
  const initialVideo = page.locator(`[data-video-id="${initialId}"] video`);
  const initialElement = await initialVideo.elementHandle();
  await expect.poll(() => initialVideo.evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  await expect(page.locator("video")).toHaveCount(2);
  await initialVideo.evaluate((video: HTMLVideoElement) => {
    video.dataset.bufferIdentity = "preserved";
    video.currentTime = 12;
  });

  const nextId = await active.evaluate((card) => {
    const next = card.nextElementSibling as HTMLElement;
    next.scrollIntoView({ block: "start", behavior: "instant" });
    return next.dataset.videoId;
  });
  await expect(active).toHaveAttribute("data-video-id", nextId!);
  await expect(initialVideo).toHaveAttribute("data-buffer-identity", "preserved");
  await expect(initialVideo).toHaveAttribute("preload", "none");
  await expect.poll(() => initialVideo.evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  await expect(page.locator("video")).toHaveCount(3);
  await expect(active.locator("video")).toHaveAttribute("preload", "auto");
  await expect.poll(() => page.locator('[data-feed-card][aria-hidden="true"] video[preload="auto"]').count()).toBeLessThanOrEqual(1);

  await initialVideo.locator("..").evaluate((card) => card.scrollIntoView({ block: "start", behavior: "instant" }));
  await expect(active).toHaveAttribute("data-video-id", initialId!);
  await expect(initialVideo).toHaveAttribute("data-buffer-identity", "preserved");
  await expect.poll(() => initialVideo.evaluate((video: HTMLVideoElement) => ({
    paused: video.paused,
    currentTime: video.currentTime,
  }))).toEqual({ paused: false, currentTime: 12 });

  for (let index = 0; index < 3; index += 1) {
    const next = await active.evaluate((card) => {
      const next = card.nextElementSibling as HTMLElement;
      next.scrollIntoView({ block: "start", behavior: "instant" });
      return next.dataset.videoId;
    });
    await expect(active).toHaveAttribute("data-video-id", next!);
    await expect.poll(() => page.locator("video").count()).toBeLessThanOrEqual(3);
  }
  await expect(page.locator('video[data-buffer-identity="preserved"]')).toHaveCount(0);
  expect(await initialElement!.evaluate((video: HTMLVideoElement) => ({
    src: video.getAttribute("src"),
    paused: video.paused,
  }))).toEqual({ src: null, paused: true });
});

test("only active and adjacent posters load as the viewer moves through the feed", async ({ page, archive }) => {
  await page.goto("/");
  const active = page.locator('[data-feed-card][aria-hidden="false"]');
  const cards = page.locator('[data-feed-card]');
  await expect(cards).toHaveCount(7);
  await expect(cards.locator("img")).toHaveCount(2);
  const initialPosters = await cards.locator("img").evaluateAll((images) => images.map((image) => new URL((image as HTMLImageElement).src).pathname));
  await expect.poll(() => archive.requestLog({ includes: "/thumbnail/" }).length).toBe(2);
  expect(archive.requestLog({ includes: "/thumbnail/" }).map((request) => request.pathname).sort()).toEqual(initialPosters.sort());

  const nextId = await active.evaluate((card) => {
    const next = card.nextElementSibling as HTMLElement;
    next.scrollIntoView({ block: "start", behavior: "instant" });
    return next.dataset.videoId;
  });
  await expect(active).toHaveAttribute("data-video-id", nextId!);
  await expect(cards.locator("img")).toHaveCount(3);
  await expect.poll(() => archive.requestLog({ includes: "/thumbnail/" }).length).toBe(3);
  await expect(active.locator("img")).toHaveJSProperty("complete", true);
});

test("one successor requests a playable buffer and yields to the active video", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, "buffered", {
      configurable: true,
      get() {
        return { length: 1, start: () => 0, end: () => Number(this.dataset.bufferEnd || "0.5") };
      },
    });
  });
  await page.goto("/");
  const active = page.locator('[data-feed-card][aria-hidden="false"] video');
  await expect.poll(() => active.evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  await expect(page.locator("video")).toHaveCount(1);
  await active.evaluate((video: HTMLVideoElement) => {
    video.dataset.bufferEnd = "6";
    video.dispatchEvent(new Event("progress"));
  });
  await expect(page.locator("video")).toHaveCount(2);
  const successor = page.locator('[data-feed-card][aria-hidden="true"] video');
  await expect(successor).toHaveAttribute("preload", "auto");
  await active.evaluate((video: HTMLVideoElement) => video.dispatchEvent(new Event("waiting")));
  await expect(successor).toHaveAttribute("preload", "none");
  await active.evaluate((video: HTMLVideoElement) => video.dispatchEvent(new Event("playing")));
  await expect(successor).toHaveAttribute("preload", "auto");
  await successor.evaluate((video: HTMLVideoElement) => {
    video.dataset.bufferEnd = "3.2";
    video.dispatchEvent(new Event("progress"));
  });
  await expect(successor).toHaveAttribute("preload", "none");
  await expect(active).toHaveAttribute("preload", "auto");
  await expect(page.locator("video")).toHaveCount(2);
});

test("a swipe starts buffering the incoming clip before it becomes active", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, "buffered", {
      configurable: true,
      get() { return { length: 1, start: () => 0, end: () => 0.5 }; },
    });
  });
  await page.goto("/");
  const active = page.locator('[data-feed-card][aria-hidden="false"]');
  const firstId = await active.getAttribute("data-video-id");
  await expect(page.locator("video")).toHaveCount(1);
  await page.locator("#feed-video-list").evaluate((scroller: HTMLElement) => {
    scroller.style.scrollSnapType = "none";
    scroller.scrollTop = scroller.clientHeight * 0.2;
  });
  await expect(page.locator("video")).toHaveCount(2);
  await expect(active).toHaveAttribute("data-video-id", firstId!);
  const incoming = page.locator('[data-feed-card][aria-hidden="true"] video');
  await expect(incoming).toHaveAttribute("preload", "auto");
  const incomingId = await incoming.locator("..").getAttribute("data-video-id");
  await page.locator("#feed-video-list").evaluate((scroller) => { scroller.scrollTop = scroller.clientHeight * 0.7; });
  await expect(active).toHaveAttribute("data-video-id", incomingId!);
  await expect.poll(() => active.locator("video").evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  await expect.poll(() => page.locator(`[data-video-id="${firstId}"] video`).evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
});

test("the virtual window follows large scroll jumps and warms the current direction", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, "buffered", {
      configurable: true,
      get() { return { length: 1, start: () => 0, end: () => 30 }; },
    });
  });
  await page.goto("/");
  const scroller = page.locator("#feed-video-list");
  const active = page.locator('[data-feed-card][aria-hidden="false"]');
  await expect(active.locator("video")).toBeAttached();

  for (const index of [12, 4]) {
    await scroller.evaluate((element: HTMLElement, index) => {
      element.style.scrollSnapType = "none";
      element.scrollTop = element.clientHeight * index;
    }, index);
    await expect.poll(() => scroller.evaluate((element) => {
      const card = element.querySelector('[data-feed-card][aria-hidden="false"]');
      if (!card) return -1;
      return Math.round((card.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop) / element.clientHeight);
    })).toBe(index);
    await expect(active.locator("video")).toBeAttached();
    await expect(page.locator("[data-feed-card]")).toHaveCount(7);
    await expect.poll(() => page.locator("video").count()).toBeLessThanOrEqual(3);
    await scroller.evaluate((element: HTMLElement) => { element.style.scrollSnapType = ""; });
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop / element.clientHeight)).toBe(index);
  }

  const previousCard = active.locator("xpath=preceding-sibling::article[1]");
  const nextCard = active.locator("xpath=following-sibling::article[1]");
  await expect(previousCard.locator("video")).toBeAttached();
  await expect(nextCard.locator("video")).toHaveCount(0);
});

test("backgrounding pauses playback and foregrounding respects a manual pause", async ({ page }) => {
  await page.goto("/");
  const video = page.locator('[data-feed-card][aria-hidden="false"] video');
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);

  await page.getByRole("button", { name: /^Show controls for / }).click();
  await page.getByRole("button", { name: "Pause video" }).click();
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  await expect(page.getByRole("button", { name: "Play video" }).first()).toBeVisible();
});

test("a play tap invokes playback within the gesture even before media is ready", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("rewind-feed-autoplay", "false");
    localStorage.setItem("rewind-feed-muted", "false");
  });
  await page.goto("/");
  const card = page.locator('[data-feed-card][aria-hidden="false"]');
  const video = card.locator("video");
  await video.evaluate((element: HTMLVideoElement) => {
    Object.defineProperty(element, "readyState", { configurable: true, get: () => 0 });
    let handlingClick = false;
    document.addEventListener("click", () => {
      handlingClick = true;
    }, true);
    document.addEventListener("click", () => { handlingClick = false; });
    const originalPlay = element.play;
    element.play = function play() {
      if (!this.dataset.firstPlayInGesture) this.dataset.firstPlayInGesture = String(handlingClick);
      return originalPlay.call(this);
    };
  });
  await card.getByRole("button", { name: "Play video", exact: true }).click();
  await expect(video).toHaveAttribute("data-first-play-in-gesture", "true");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
});

test("dragging the seek bar issues one seek on release while keyboard seeks stay immediate", async ({ page }, testInfo) => {
  await page.goto("/");
  const card = page.locator('[data-feed-card][aria-hidden="false"]');
  const video = card.locator("video");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
  await video.evaluate((element: HTMLVideoElement) => {
    let currentTime = 0;
    element.dataset.seekCount = "0";
    Object.defineProperty(element, "currentTime", {
      configurable: true,
      get: () => currentTime,
      set(value: number) {
        currentTime = value;
        element.dataset.seekCount = String(Number(element.dataset.seekCount) + 1);
      },
    });
  });
  const seek = card.getByRole("slider", { name: /^Seek / });
  const bounds = await seek.boundingBox();
  expect(bounds).not.toBeNull();
  const y = bounds!.y + bounds!.height / 2;
  if (testInfo.project.name === "mobile-chromium") {
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: bounds!.x + bounds!.width * 0.2, y }],
    });
    for (let step = 1; step <= 12; step += 1) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: bounds!.x + bounds!.width * (0.2 + step * 0.05), y }],
      });
    }
    await expect(video).toHaveAttribute("data-seek-count", "0");
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await session.detach();
  } else {
    await page.mouse.move(bounds!.x + bounds!.width * 0.2, y);
    await page.mouse.down();
    await page.mouse.move(bounds!.x + bounds!.width * 0.8, y, { steps: 12 });
    await expect(video).toHaveAttribute("data-seek-count", "0");
    await page.mouse.up();
  }
  await expect(video).toHaveAttribute("data-seek-count", "1");
  const percentage = Number(await seek.inputValue());
  expect(percentage).toBeGreaterThan(70);
  expect(percentage).toBeLessThan(90);
  const selectedTime = percentage * 30 / 100;
  expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(selectedTime);
  await seek.press("ArrowLeft");
  await expect(video).toHaveAttribute("data-seek-count", "2");
});
