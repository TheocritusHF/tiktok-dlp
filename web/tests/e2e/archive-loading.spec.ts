import { test, expect } from "./fixtures/archive";
import { revealFeedControls } from "./helpers";

test("the feed renders videos while creator metadata is still pending", async ({ page, archive }) => {
  const creators = archive.delayNextRequest((_request, url) => url.pathname === "/api/creators");
  await page.goto("/");
  await creators.waitUntilRequested();
  try {
    await expect(page.locator("[data-video-id]").first()).toBeVisible();
  } finally {
    creators.release();
  }
  await revealFeedControls(page);
  await page.getByRole("button", { name: "Creator filter: All creators" }).click();
  await expect(page.getByRole("option", { name: "@alice.archive", exact: true })).toBeVisible();
});

test("the dashboard fetches only its five recent videos and renders before totals finish", async ({ page, archive }) => {
  const stats = archive.delayNextRequest((_request, url) => url.pathname === "/api/stats");
  await page.goto("/dashboard");
  await stats.waitUntilRequested();
  try {
    await expect(page.getByRole("link").filter({ hasText: "Alice Archive archive clip 001" })).toBeVisible();
    const requests = archive.requestLog({ method: "GET", pathname: "/api/videos" });
    expect(requests).toHaveLength(1);
    expect(new URLSearchParams(requests[0].search).get("limit")).toBe("5");
  } finally {
    stats.release();
  }
});

test("changing creators cancels obsolete pages without refetching archive metadata", async ({ page, archive }) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    const canceled: string[] = [];
    Object.assign(window, { canceledArchiveRequests: canceled });
    window.fetch = (input, init) => {
      init?.signal?.addEventListener("abort", () => canceled.push(String(input)), { once: true });
      return originalFetch(input, init);
    };
  });
  await page.goto("/dashboard/videos");
  const rows = page.getByRole("list", { name: "Saved videos" }).getByRole("listitem");
  await expect(rows).toHaveCount(100);
  const creatorsBefore = archive.requestLog({ pathname: "/api/creators" }).length;
  const statsBefore = archive.requestLog({ pathname: "/api/stats" }).length;
  const nextPage = archive.delayNextRequest((_request, url) => (
    url.pathname === "/api/videos" && url.searchParams.has("cursor")
  ));
  await page.getByRole("button", { name: "Load more videos" }).click();
  await nextPage.waitUntilRequested();
  try {
    await page.getByRole("button", { name: "Creator filter: All creators" }).click();
    await page.getByRole("option", { name: "@bob.builds", exact: true }).click();
    await expect(rows).toHaveCount(24);
    await expect(rows.first()).toContainText("Bob Builds");
    expect(archive.requestLog({ pathname: "/api/creators" })).toHaveLength(creatorsBefore);
    expect(archive.requestLog({ pathname: "/api/stats" })).toHaveLength(statsBefore);
    expect(await page.evaluate(() => (
      (window as typeof window & { canceledArchiveRequests: string[] }).canceledArchiveRequests
        .some((url) => new URL(url).searchParams.has("cursor"))
    ))).toBe(true);
  } finally {
    nextPage.release();
  }
  await expect(rows).toHaveCount(24);
});
