import {
  test,
  expect,
  type Browser,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import fs from "node:fs";

const API = process.env.E2E_API_URL ?? "http://127.0.0.1:8000";
const FRONTEND = process.env.E2E_FRONTEND_URL ?? "http://localhost:3000";

async function pair(
  browser: Browser,
  request: APIRequestContext,
  config: object,
  blockCandidates = false,
) {
  const created = await (
    await request.post(`${API}/api/meetings/instant`)
  ).json();
  const contexts = await Promise.all(
    [0, 1].map(() =>
      browser.newContext({
        permissions: [
          "camera",
          "microphone",
          "clipboard-read",
          "clipboard-write",
        ],
      }),
    ),
  );
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  for (const page of pages) {
    await page.route("**/api/rtc-config", (route) =>
      route.fulfill({ json: config }),
    );
    await page.addInitScript((blocked) => {
      const Original = window.RTCPeerConnection;
      const peers: RTCPeerConnection[] = [];
      Object.defineProperty(window, "__testPeers", { value: peers });
      Object.defineProperty(window, "__blockCandidates", {
        value: blocked,
        writable: true,
      });
      window.RTCPeerConnection = class extends Original {
        constructor(configuration?: RTCConfiguration) {
          super(configuration);
          peers.push(this);
        }
      };
      const OriginalSocket = window.WebSocket;
      window.WebSocket = class extends OriginalSocket {
        send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
          if (
            this.url.includes("/ws/meetings/") &&
            typeof data === "string" &&
            (window as Window & { __blockCandidates?: boolean })
              .__blockCandidates
          ) {
            const message = JSON.parse(data);
            if (message.type === "candidate" && message.payload.candidate) {
              message.payload.candidate = message.payload.candidate.replace(
                /^(candidate:\S+ \d+ \S+ \d+) \S+ \d+/,
                "$1 203.0.113.1 50000",
              );
              data = JSON.stringify(message);
            }
            if (message.payload?.sdp) {
              message.payload.sdp = message.payload.sdp.replace(
                /^(a=candidate:\S+ \d+ \S+ \d+) \S+ \d+/gm,
                "$1 203.0.113.1 50000",
              );
              data = JSON.stringify(message);
            }
          }
          super.send(data);
        }
      };
    }, blockCandidates);
  }
  const [host, guest] = pages;
  await host.goto(FRONTEND);
  await host.evaluate(
    ({ code, token }) => localStorage.setItem(`zoom:host:${code}`, token),
    {
      code: created.meeting.meeting_code,
      token: created.host_token,
    },
  );
  for (const [index, page] of pages.entries()) {
    await page.goto(`${FRONTEND}/meeting/${created.meeting.meeting_code}`);
    await page
      .getByLabel("Your name", { exact: true })
      .fill(index === 0 ? "RTC host" : "RTC guest");
    await page
      .getByRole("button", { name: "Enable camera & microphone", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Mute microphone", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("button", {
        name: index === 0 ? "Start Meeting" : "Join Meeting",
        exact: true,
      })
      .click();
    await expect(page.locator(".room-connection")).toContainText("Connected");
  }
  return {
    host,
    guest,
    async close() {
      await request.post(
        `${API}/api/meetings/${created.meeting.meeting_code}/end`,
        {
          headers: { Authorization: `Bearer ${created.host_token}` },
        },
      );
      await Promise.all(contexts.map((context) => context.close()));
    },
  };
}

async function packets(page: Page) {
  return page.evaluate(async () => {
    const peers =
      (window as Window & { __testPeers?: RTCPeerConnection[] }).__testPeers ??
      [];
    const result = { audio: 0, video: 0, relay: false };
    for (const pc of peers) {
      const stats = await pc.getStats();
      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "audio")
          result.audio += report.packetsReceived ?? 0;
        if (report.type === "inbound-rtp" && report.kind === "video")
          result.video += report.packetsReceived ?? 0;
        if (report.type === "transport" && report.selectedCandidatePairId) {
          const pair = stats.get(report.selectedCandidatePairId);
          result.relay =
            stats.get(pair.localCandidateId)?.candidateType === "relay";
        }
      });
    }
    return result;
  });
}

test("screen sharing replaces video, preserves audio, and restores camera", async ({
  browser,
  request,
}) => {
  const room = await pair(browser, request, {
    ice_servers: [],
    ice_transport_policy: "all",
  });
  try {
    const { host, guest } = room;
    await expect
      .poll(async () => (await packets(guest)).video)
      .toBeGreaterThan(0);
    const original = await host.evaluate(() => {
      const pc = (window as unknown as { __testPeers: RTCPeerConnection[] })
        .__testPeers[0];
      return {
        audio: pc.getSenders().find((s) => s.track?.kind === "audio")?.track
          ?.id,
        video: pc.getSenders().find((s) => s.track?.kind === "video")?.track
          ?.id,
      };
    });
    // A synthetic canvas is the selected source; capture and RTP transport are real.
    await host.evaluate(() => {
      let cancel = true;
      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
        configurable: true,
        value: async () => {
          if (cancel) {
            cancel = false;
            throw new DOMException("Cancelled", "NotAllowedError");
          }
          const canvas = document.createElement("canvas");
          canvas.width = 1280;
          canvas.height = 720;
          const ctx = canvas.getContext("2d")!;
          ctx.fillStyle = "#1565e0";
          ctx.fillRect(0, 0, 1280, 720);
          ctx.fillStyle = "white";
          ctx.font = "48px sans-serif";
          ctx.fillText("Shared presentation", 80, 120);
          const capture = canvas.captureStream(15);
          Object.defineProperty(window, "__displayTrack", {
            configurable: true,
            value: capture.getVideoTracks()[0],
          });
          return capture;
        },
      });
    });
    await host
      .getByRole("button", { name: "Share screen", exact: true })
      .click();
    await expect(host.getByRole("status").last()).toContainText(
      "cancelled or blocked",
    );
    await host
      .getByRole("button", { name: "Share screen", exact: true })
      .click();
    await expect(guest.locator(".screen-tile")).toContainText("Sharing screen");
    await expect
      .poll(() =>
        guest
          .locator(".screen-tile video")
          .evaluate((video: HTMLVideoElement) => {
            const canvas = document.createElement("canvas");
            canvas.width = 1;
            canvas.height = 1;
            const ctx = canvas.getContext("2d")!;
            ctx.drawImage(video, 0, 0, 1, 1);
            const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
            return b > 150 && b > r * 2 && g > 50;
          }),
      )
      .toBe(true);
    const during = await host.evaluate(() => {
      const pc = (window as unknown as { __testPeers: RTCPeerConnection[] })
        .__testPeers[0];
      return {
        audio: pc.getSenders().find((s) => s.track?.kind === "audio")?.track
          ?.id,
        video: pc.getSenders().find((s) => s.track?.kind === "video")?.track
          ?.id,
        state: pc.connectionState,
      };
    });
    expect(during.audio).toBe(original.audio);
    expect(during.video).not.toBe(original.video);
    expect(during.state).toBe("connected");
    await host.screenshot({ path: "../artifacts/screen-sharing.png" });
    // Browser's native Stop Sharing event follows the same cleanup path.
    await host.evaluate(() => {
      const track = (window as unknown as { __displayTrack: MediaStreamTrack })
        .__displayTrack;
      track.stop();
      track.dispatchEvent(new Event("ended"));
    });
    await expect(guest.locator(".screen-tile")).toHaveCount(0);
    await expect
      .poll(() =>
        host.evaluate(
          () =>
            (
              window as unknown as { __testPeers: RTCPeerConnection[] }
            ).__testPeers[0]
              .getSenders()
              .find((s) => s.track?.kind === "video")?.track?.id,
        ),
      )
      .toBe(original.video);
    // Sharing works with the camera disabled and restores that disabled state.
    await host.getByRole("button", { name: "Stop video", exact: true }).click();
    await host
      .getByRole("button", { name: "Share screen", exact: true })
      .click();
    await expect(guest.locator(".screen-tile")).toBeVisible();
    await host
      .getByRole("button", { name: "Stop sharing screen", exact: true })
      .click();
    await expect(guest.locator(".screen-tile")).toHaveCount(0);
    await expect(
      guest
        .locator(".video-tile")
        .filter({ hasText: "RTC host" })
        .locator(".tile-placeholder"),
    ).toBeVisible();
    const audioBefore = (await packets(guest)).audio;
    await expect
      .poll(async () => (await packets(guest)).audio)
      .toBeGreaterThan(audioBefore);
    await host.setViewportSize({ width: 390, height: 844 });
    expect(
      await host.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await host.screenshot({ path: "../artifacts/meeting-mobile.png" });
  } finally {
    await room.close();
  }
});

test("meeting chat delivers plain text with names and works on mobile", async ({
  browser,
  request,
}) => {
  const room = await pair(browser, request, { ice_servers: [] });
  try {
    for (const page of [room.host, room.guest])
      await page
        .getByRole("button", { name: "Show chat", exact: true })
        .click();
    await room.host
      .getByLabel("Message everyone", { exact: true })
      .fill("Hello everyone! <b>Plain text</b>");
    await room.host.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      room.guest.getByRole("log", { name: "Messages" }),
    ).toContainText("Hello everyone! <b>Plain text</b>");
    await expect(room.guest.locator(".chat-meta strong")).toHaveText(
      "RTC host",
    );
    await expect(room.guest.locator(".chat-message b")).toHaveCount(0);
    await room.guest
      .getByLabel("Message everyone", { exact: true })
      .fill("Sounds good!\nReady to present.");
    await room.guest.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      room.host.getByRole("log", { name: "Messages" }),
    ).toContainText("Ready to present.");
    await expect(room.host.locator(".chat-message")).toHaveCount(2);
    await room.host.screenshot({ path: "../artifacts/meeting-chat.png" });
    await room.guest.setViewportSize({ width: 390, height: 844 });
    expect(
      await room.guest.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await room.guest
      .getByRole("button", { name: "Close chat", exact: true })
      .click();
    await room.guest
      .getByRole("button", { name: "Show participants", exact: true })
      .click();
    await expect(room.guest.locator(".participants-heading")).toContainText(
      "Participants",
    );
    await room.guest
      .getByRole("button", { name: "Show chat", exact: true })
      .click();
    await expect(room.guest.locator(".chat-panel")).toBeVisible();
    await expect(
      room.guest.getByRole("button", { name: "Close participants" }),
    ).toHaveCount(0);
    await expect
      .poll(async () => (await packets(room.guest)).audio)
      .toBeGreaterThan(0);
  } finally {
    await room.close();
  }
});

test("ICE failure diagnostics and retry recover without leaving the room", async ({
  browser,
  request,
}) => {
  test.setTimeout(90000);
  const room = await pair(
    browser,
    request,
    { ice_servers: [], ice_transport_policy: "all" },
    true,
  );
  try {
    await expect(
      room.guest.getByRole("button", { name: "Copy connection diagnostics" }),
    ).toBeVisible({ timeout: 30000 });
    await room.guest
      .getByRole("button", { name: "Copy connection diagnostics" })
      .click();
    await expect(room.guest.getByRole("status").last()).toContainText(
      "Connection diagnostics copied",
    );
    const report = JSON.parse(
      await room.guest.evaluate(() => navigator.clipboard.readText()),
    );
    expect(report.peers[0].signaling).toBe("stable");
    expect(report.peers[0].remoteGatheringComplete).toBe(true);
    expect(report.peers[0].remoteCandidates.host).toBeGreaterThan(0);
    expect(report.peers[0].connection).toBe("failed");
    await expect(room.guest.locator(".room-connection")).toContainText(
      "Signaling: Connected",
    );
    await expect(room.guest.locator(".media-connection")).toHaveAttribute(
      "data-state",
      "failed",
    );
    expect(JSON.stringify(report)).not.toMatch(
      /candidate:|ice-pwd|credential|username|address|sdp/i,
    );
    await test.info().attach("failed-ice-diagnostics", {
      body: JSON.stringify(report),
      contentType: "application/json",
    });
    for (const page of [room.host, room.guest])
      await page.evaluate(() => {
        (window as Window & { __blockCandidates?: boolean }).__blockCandidates =
          false;
      });
    await room.guest
      .getByRole("button", { name: "Retry media connection" })
      .click();
    for (const page of [room.host, room.guest]) {
      await expect
        .poll(async () => (await packets(page)).audio, { timeout: 25000 })
        .toBeGreaterThan(0);
      await expect
        .poll(async () => (await packets(page)).video, { timeout: 25000 })
        .toBeGreaterThan(0);
      await expect(page.locator(".room-error")).toHaveCount(0);
      await expect(page.locator(".media-connection")).toHaveAttribute(
        "data-state",
        "connected",
      );
    }
  } finally {
    await room.close();
  }
});

for (const transport of ["udp", "tcp"] as const)
  test(`relay-only ${transport} transport receives real audio and video in both directions`, async ({
    browser,
    request,
  }) => {
    test.setTimeout(90000);
    const config = process.env.E2E_RTC_CONFIG_FILE
      ? JSON.parse(
          fs
            .readFileSync(process.env.E2E_RTC_CONFIG_FILE, "utf8")
            .replace(/^\uFEFF/, ""),
        )
      : await (await request.get(`${API}/api/rtc-config`)).json();
    const relayServers = config.ice_servers.flatMap((server: RTCIceServer) => {
      const urls = (
        Array.isArray(server.urls) ? server.urls : [server.urls]
      ).filter(
        (url) =>
          /^turns?:/.test(url) &&
          (transport === "tcp"
            ? url.includes("transport=tcp") ||
              (url.startsWith("turns:") && !url.includes("transport=udp"))
            : !url.startsWith("turns:") && !url.includes("transport=tcp")),
      );
      return urls.length ? [{ ...server, urls }] : [];
    });
    const hasTurn = relayServers.length > 0;
    test.skip(
      !hasTurn,
      "TURN credentials are not configured; direct media cannot prove relay connectivity.",
    );
    const room = await pair(browser, request, {
      ...config,
      ice_servers: relayServers,
      ice_transport_policy: "relay",
    });
    try {
      for (const page of [room.host, room.guest]) {
        await expect
          .poll(async () => (await packets(page)).audio, { timeout: 30000 })
          .toBeGreaterThan(0);
        await expect
          .poll(async () => (await packets(page)).video, { timeout: 30000 })
          .toBeGreaterThan(0);
        expect((await packets(page)).relay).toBe(true);
      }
      await test.info().attach("relay-rtp", {
        body: JSON.stringify({
          host: await packets(room.host),
          guest: await packets(room.guest),
        }),
        contentType: "application/json",
      });
    } finally {
      await room.close();
    }
  });
