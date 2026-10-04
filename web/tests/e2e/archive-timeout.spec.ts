import { test, expect } from "./fixtures/archive";

test("an initial video request times out and a manual retry starts playback", async ({ page, archive }) => {
  await page.clock.install();
  const request = archive.delayNextRequest((_request, url) => url.pathname === "/api/videos");
  await page.goto("/");
  await request.waitUntilRequested();
  await expect(page.getByRole("heading", { name: "Loading videos" })).toBeVisible();
  await page.clock.fastForward(15_001);
  await expect(page.getByRole("heading", { name: "Could not load the archive", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Request timed out");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator('[data-feed-card][aria-hidden="false"] video')).toHaveJSProperty("paused", false);
  await expect(page.getByRole("alert")).toHaveCount(0);
  request.release();
});

test("a stalled bookmark list stops waiting after one deadline and retries manually", async ({ page, archive }) => {
  await page.clock.install();
  await page.addInitScript(() => localStorage.setItem("rewind-default-feed", "bookmarks"));
  const request = archive.delayNextRequest((_request, url) => url.pathname === "/api/bookmarks");
  await page.goto("/");
  await request.waitUntilRequested();
  await expect(page.getByRole("heading", { name: "Loading bookmarks" })).toBeVisible();
  await page.clock.fastForward(15_001);
  await expect(page.getByRole("heading", { name: "Could not load bookmarks", exact: true })).toBeVisible();
  await expect(page.getByText("Request timed out. Please retry.", { exact: true })).toBeVisible();
  expect(archive.requestLog({ pathname: "/api/bookmarks" })).toHaveLength(1);
  await page.getByRole("button", { name: "Retry bookmarks", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Could not load bookmarks", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Loading bookmarks" })).toHaveCount(0);
  request.release();
});
