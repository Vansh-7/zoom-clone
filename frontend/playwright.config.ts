import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    channel: process.env.E2E_BROWSER_CHANNEL,
    baseURL: process.env.E2E_FRONTEND_URL ?? "http://localhost:3000",
    timezoneId: "Asia/Kolkata",
    viewport: { width: 1440, height: 1000 },
    // Relay fixtures contain credentials; keep them out of saved network traces.
    trace: process.env.E2E_RTC_CONFIG_FILE ? "off" : "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
    },
    permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"],
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
});
