import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts", "plugins/*/server/**/*.test.ts", "plugins/*/test/**/*.test.ts", "integrations/*/server/**/*.test.ts", "integrations/*/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
    testTimeout: 20000,
    // Setup hooks start whole hubs (plugin processes, databases). A CI runner now and then stalls for about ten
    // seconds, every test file at once, and vitest's own 10 s for a hook is then not enough.
    hookTimeout: 30000,
    pool: "forks",
    // Every temp file of the run, spawned processes' included, lands in one folder that is deleted at the end.
    globalSetup: ["packages/testkit/src/temp-dir.ts"],
    // Messages are asserted in English; a developer's own LANG must not change them.
    env: { PIOMIO_LANG: "en" },
  },
});
