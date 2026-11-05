import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { piomioDesktop: { scheme: "piomio", overlayTitleBar: true } });
  });
  await page.route("**/api/**", route => route.fulfill({ json: { items: [], more: false } }));
});

for (const panel of ["library", "page"]) {
  test(`${panel}: covers the top edge, reserves traffic lights and closes normally`, async ({ page }) => {
    await page.goto(`/e2e/panels.html?panel=${panel}`);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    for (const selector of ["html", "body", "#root"]) {
      await expect(page.locator(selector)).toHaveCSS("background-color", "rgb(236, 231, 224)");
    }
    const strip = dialog.locator(".window-titlebar");
    await expect(strip).toHaveAttribute("data-tauri-drag-region", "");
    expect((await strip.boundingBox())?.height).toBe(52);
    const close = dialog.locator("header button").first();
    expect((await close.boundingBox())!.y).toBeGreaterThanOrEqual(52);
    await expect(close).not.toHaveAttribute("data-tauri-drag-region");
    expect(await dialog.evaluate(el => {
      const top = document.elementFromPoint(1, 1);
      return { y: el.getBoundingClientRect().y, covered: !!top && el.contains(top), opacity: getComputedStyle(el).opacity, background: getComputedStyle(top!).backgroundColor };
    })).toEqual({ y: 0, covered: true, opacity: "1", background: "rgb(247, 244, 239)" });
    await page.screenshot({ path: `output/playwright/${test.info().project.name}-${panel}-after.png`, animations: "disabled" });
    await close.click();
    await expect(dialog).toHaveCount(0);
  });

  test(`${panel}: web/mobile and native fullscreen have no desktop spacer`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/e2e/panels.html?panel=${panel}`);
    await page.evaluate(() => document.documentElement.classList.remove("owl-titlebar"));
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator(".window-titlebar")).toHaveCSS("height", "0px");
    expect((await dialog.locator("header button").first().boundingBox())!.y).toBe(0);
    await page.screenshot({ path: `output/playwright/${test.info().project.name}-${panel}-mobile.png`, animations: "disabled" });
  });
}

test("narrow settings reserve titlebar; side settings do not add a second strip", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 720 });
  await page.goto("/e2e/panels.html?panel=settings");
  const panel = page.locator("aside");
  expect((await panel.locator(".window-titlebar").boundingBox())!.height).toBe(52);
  expect((await panel.getByRole("button").first().boundingBox())!.y).toBeGreaterThanOrEqual(52);
  await page.setViewportSize({ width: 1100, height: 720 });
  await expect(panel.locator(".window-titlebar")).toBeHidden();
});

test("a tall modal stays below traffic lights and fits a short window", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 350 });
  await page.goto("/e2e/panels.html?panel=modal");
  const dialog = page.getByRole("dialog");
  const box = (await dialog.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(52);
  expect(box.y + box.height).toBeLessThanOrEqual(350);
  await dialog.getByRole("button").click();
  await expect(dialog).toHaveCount(0);
});
