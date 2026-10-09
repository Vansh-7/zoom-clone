import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

if (!process.env.E2E_API_URL || !process.env.E2E_FRONTEND_URL)
  throw new Error(
    "Set both release URLs explicitly before running acceptance tests.",
  );

export default defineConfig({
  ...base,
  testDir: "./verification",
  timeout: 180000,
  outputDir: "test-results/release",
  // Network traces may contain capabilities and TURN credentials.
  use: {
    ...base.use,
    trace: "off",
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
});
