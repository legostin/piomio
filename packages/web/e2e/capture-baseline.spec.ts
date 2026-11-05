import { test } from "@playwright/test";

// CI runs this with the base branch's production sources, before restoring the PR sources.
for (const panel of ["library", "page"]) {
  test(`capture ${panel} before`, async ({ page }) => {
    await page.addInitScript(() => Object.assign(window, { piomioDesktop: { scheme: "piomio", overlayTitleBar: true } }));
    await page.route("**/api/**", route => route.fulfill({ json: { items: [], more: false } }));
    await page.goto(`/e2e/panels.html?panel=${panel}`);
    await page.getByRole("dialog").waitFor();
    await page.screenshot({ path: `output/playwright/${test.info().project.name}-${panel}-before.png`, animations: "disabled" });
  });
}
