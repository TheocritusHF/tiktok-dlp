import { test, expect } from "./fixtures/archive";
import { revealFeedControls } from "./helpers";

// System-font baselines are reviewed on the Ubuntu 24.04 Chromium CI runner.
// Other host font sets can render differently; do not regenerate these blindly.
test("desktop dashboard visual regression", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop baseline");
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page).toHaveScreenshot("dashboard-desktop.png", { fullPage: true });
});

test("mobile feed visual regression", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile baseline");
  await page.goto("/?video=1001");
  await revealFeedControls(page);
  await expect(page).toHaveScreenshot("feed-mobile.png", { fullPage: true });
});
