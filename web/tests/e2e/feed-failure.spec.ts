import { test, expect } from "./fixtures/archive";
import { expectNoHorizontalOverflow } from "./helpers";

test("an unavailable video list is not presented as an empty archive", async ({ page, archive }) => {
  archive.failNextRequests((_request, url) => url.pathname === "/api/videos", 1, 503, "Video list unavailable");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Could not load the archive", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No saved videos", exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("Video list unavailable");
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator('[data-feed-card][aria-hidden="false"] video')).toHaveJSProperty("paused", false);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("failed pagination stays visible and retries without replacing the playing video", async ({ page, archive }) => {
  archive.failNextRequests((_request, url) => url.pathname === "/api/videos" && url.searchParams.has("cursor"), 1, 503, "More videos unavailable");
  await page.goto("/");
  await expect(page.locator('[data-feed-card][aria-hidden="false"] video')).toHaveJSProperty("paused", false);
  const scroller = page.locator("#feed-video-list");
  await scroller.evaluate((element: HTMLElement) => {
    element.style.scrollSnapType = "none";
    element.scrollTop = element.clientHeight * 30;
  });
  const active = page.locator('[data-feed-card][aria-hidden="false"]');
  await expect(page.getByRole("alert")).toContainText("More videos unavailable");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  const currentId = await active.getAttribute("data-video-id");
  const video = active.locator("video");
  const original = await video.elementHandle();
  await video.evaluate((element: HTMLVideoElement) => { element.currentTime = 12; });
  const previousOffset = await scroller.evaluate((element) => element.scrollTop);
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(active).toHaveAttribute("data-video-id", currentId!);
  expect(await video.evaluate((element, original) => element === original, original)).toBe(true);
  await expect(video).toHaveJSProperty("currentTime", 12);
  await expect(video).toHaveJSProperty("paused", false);
  await expect(scroller).toHaveJSProperty("scrollTop", previousOffset);
  const requests = archive.requestLog({ pathname: "/api/videos" });
  expect(requests).toHaveLength(3);
  expect(requests[1].search).toBe(requests[2].search);
});

test("retrying creator metadata preserves later pages and the active player", async ({ page, archive }) => {
  archive.failNextRequests((_request, url) => url.pathname === "/api/creators", 1, 503, "Creator list unavailable");
  await page.goto("/");
  const active = page.locator('[data-feed-card][aria-hidden="false"]');
  await expect(active.locator("video")).toHaveJSProperty("paused", false);
  const scroller = page.locator("#feed-video-list");
  await scroller.evaluate((element: HTMLElement) => {
    element.style.scrollSnapType = "none";
    element.scrollTop = element.clientHeight * 30;
  });
  await expect.poll(() => archive.requestLog({ pathname: "/api/videos" }).length).toBe(2);
  await expect.poll(() => scroller.evaluate(element => element.scrollHeight / element.clientHeight)).toBe(72);
  await scroller.evaluate((element: HTMLElement) => { element.scrollTop = element.clientHeight * 40; });
  await expect.poll(() => active.evaluate(element => element.style.top)).toBe("4000%");
  const currentId = await active.getAttribute("data-video-id");
  const video = active.locator("video");
  const original = await video.elementHandle();
  await video.evaluate((element: HTMLVideoElement) => { element.currentTime = 12; });
  const previousOffset = await scroller.evaluate(element => element.scrollTop);
  await expect(page.getByRole("alert")).toContainText("Creator list unavailable");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(active).toHaveAttribute("data-video-id", currentId!);
  expect(await video.evaluate((element, original) => element === original, original)).toBe(true);
  await expect(video).toHaveJSProperty("currentTime", 12);
  await expect(video).toHaveJSProperty("paused", false);
  await expect(scroller).toHaveJSProperty("scrollTop", previousOffset);
  expect(archive.requestLog({ pathname: "/api/videos" })).toHaveLength(2);
  expect(archive.requestLog({ pathname: "/api/creators" })).toHaveLength(2);
});
