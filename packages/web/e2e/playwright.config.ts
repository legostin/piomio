import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: process.env.PANEL_BASELINE ? "capture-baseline.spec.ts" : "window-panels.spec.ts",
  outputDir: "../../../output/playwright/results",
  use: { colorScheme: "light", baseURL: "http://127.0.0.1:5175", viewport: { width: 1100, height: 720 } },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }, { name: "webkit", use: { browserName: "webkit" } }],
  webServer: { command: "npm run dev -w @piomio/web -- --host 127.0.0.1 --port 5175", cwd: "../../..", url: "http://127.0.0.1:5175", reuseExistingServer: true },
});
