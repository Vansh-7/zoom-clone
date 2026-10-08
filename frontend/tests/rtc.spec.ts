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
    const report = JSON.parse(
      await room.guest.evaluate(() => navigator.clipboard.readText()),
    );
    expect(report.peers[0].signaling).toBe("stable");
    expect(report.peers[0].remoteGatheringComplete).toBe(true);
    expect(report.peers[0].remoteCandidates.host).toBeGreaterThan(0);
    expect(report.peers[0].connection).toBe("failed");
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
