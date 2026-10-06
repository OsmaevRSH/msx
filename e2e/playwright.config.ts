import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// E2E в настоящей web-версии MSX (спец. §4, §14.4; решение Р-27): Chromium открывает http://msx.benzac.de, а тот
// грузит плагин и mock с 127.0.0.1 (Р-31). Публичная http-страница → loopback — это Local Network Access (Chrome
// 142+), без флага ниже iframe плагина блокируется с ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS (Plan B §12.6).

const ROOT = fileURLToPath(new URL("../", import.meta.url));

export default defineConfig({
  testDir: ".",
  outputDir: `${ROOT}test-results`,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: process.env.CI !== undefined,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    viewport: { width: 1280, height: 720 },
    launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks", "--autoplay-policy=no-user-gesture-required"] },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tools/dev.mjs --no-watch --e2e",
    cwd: ROOT,
    url: "http://127.0.0.1:8080/start.json",
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
