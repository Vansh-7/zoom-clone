import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Exercise existing workflows without Chromium-only media flags or permissions.
export default defineConfig({
  ...base,
  testMatch: [
    "workflows.spec.ts",
    "meeting-playback.spec.ts",
    "meeting-ui.spec.ts",
    "private-chat.spec.ts",
  ],
  grep: /scheduled meeting downloads|workflow availability|dashboard, join|responsive pages|scheduling uses|backend unavailable|Start Meeting claims|guest waits|permission denial|meeting gallery|remote audio|original favicon|chat preserves reading|meeting popovers|private chat/,
  use: {
    ...base.use,
    channel: undefined,
    permissions: [],
    launchOptions: {},
  },
  projects: [
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
