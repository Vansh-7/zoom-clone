import {
  fullscreenBounds,
  toggleMeetingFullscreen,
} from "./helpers/fullscreen";
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
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (this.url.includes("/ws/meetings/")) {
            Object.defineProperty(window, "__testSocket", {
              configurable: true,
              value: this,
            });
            this.addEventListener("message", (event) => {
              const message = JSON.parse(event.data);
              if (message.type === "welcome")
                Object.defineProperty(window, "__testSelf", {
                  configurable: true,
                  value: message.self_id,
                });
            });
          }
        }
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
    code: created.meeting.meeting_code as string,
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
    const result = {
      audio: 0,
      video: 0,
      audioOut: 0,
      videoOut: 0,
      frames: 0,
      relay: false,
      relayProtocol: "",
    };
    for (const pc of peers) {
      const stats = await pc.getStats();
      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "audio")
          result.audio += report.packetsReceived ?? 0;
        if (report.type === "inbound-rtp" && report.kind === "video") {
          result.video += report.packetsReceived ?? 0;
          result.frames += report.framesDecoded ?? 0;
        }
        if (report.type === "outbound-rtp" && report.kind === "audio")
          result.audioOut += report.packetsSent ?? 0;
        if (report.type === "outbound-rtp" && report.kind === "video")
          result.videoOut += report.packetsSent ?? 0;
        if (report.type === "transport" && report.selectedCandidatePairId) {
          const pair = stats.get(report.selectedCandidatePairId);
          const local = stats.get(pair.localCandidateId);
          result.relay =
            local?.candidateType === "relay" &&
            stats.get(pair.remoteCandidateId)?.candidateType === "relay";
          result.relayProtocol = local?.relayProtocol ?? "";
        }
      });
    }
    return result;
  });
}

async function received(page: Page) {
  return page.evaluate(async () => {
    const result = { camera: 0, screen: 0, audio: 0 };
    for (const pc of (
      window as unknown as { __testPeers: RTCPeerConnection[] }
    ).__testPeers.filter((pc) => pc.connectionState !== "closed")) {
      let videoIndex = 0;
      for (const transceiver of pc.getTransceivers()) {
        const channel =
          transceiver.receiver.track.kind === "audio"
            ? "audio"
            : videoIndex++ === 0
              ? "camera"
              : "screen";
        (await transceiver.receiver.getStats()).forEach((report) => {
          if (report.type === "inbound-rtp")
            result[channel] +=
              channel === "audio"
                ? (report.packetsReceived ?? 0)
                : (report.framesDecoded ?? 0);
        });
      }
    }
    return result;
  });
}

async function displaySource(page: Page) {
  await page.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const context = canvas.getContext("2d")!;
      const stream = canvas.captureStream(15);
      const track = stream.getVideoTracks()[0];
      Object.defineProperty(window, "__displayTrack", {
        configurable: true,
        value: track,
      });
      let frame = 0;
      const paint = () => {
        if (track.readyState !== "live") return;
        context.fillStyle = "#1565e0";
        context.fillRect(0, 0, 1280, 720);
        context.fillStyle = "white";
        context.font = "48px sans-serif";
        context.fillText("Shared presentation", 80, 120);
        context.fillStyle = frame++ % 2 ? "white" : "black";
        context.fillRect(20, 20, 30, 30);
        requestAnimationFrame(paint);
      };
      paint();
      return stream;
    };
  });
}

async function toolbarInViewport(page: Page, host = true) {
  const controls = page.locator(".meeting-toolbar button");
  await expect(controls).toHaveCount(host ? 9 : 8);
  for (const control of await controls.all()) {
    await expect(control).toBeVisible();
    await expect(control).toBeEnabled();
    expect(
      await control.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        );
        return (
          rect.width >= 38 &&
          rect.height >= 44 &&
          rect.left >= 0 &&
          rect.top >= 0 &&
          rect.right <= innerWidth &&
          rect.bottom <= innerHeight &&
          !!hit &&
          element.contains(hit)
        );
      }),
    ).toBe(true);
    await control.click({ trial: true });
  }
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollHeight <= innerHeight &&
        document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
])
  test(`toolbar and dual video stay inside the ${viewport.width}px viewport with panels and fullscreen`, async ({
    browser,
    request,
  }) => {
    test.setTimeout(180000);
    const room = await pair(browser, request, { ice_servers: [] });
    try {
      const { host, guest } = room;
      for (const page of [host, guest]) await page.setViewportSize(viewport);
      for (const page of [host, guest]) {
        await expect
          .poll(async () => (await received(page)).camera)
          .toBeGreaterThan(0);
        for (const video of await page.locator(".camera-tile video").all()) {
          await expect
            .poll(() =>
              video.evaluate(
                (element: HTMLVideoElement) =>
                  element.readyState >= 2 && element.videoWidth > 0,
              ),
            )
            .toBe(true);
          const bounds = await video.boundingBox();
          expect(bounds?.height).toBeGreaterThan(100);
          expect(bounds?.width).toBeGreaterThan(100);
        }
        await toolbarInViewport(page, page === host);
      }
      await host.screenshot({
        path: `../artifacts/dual-normal-${viewport.width}.png`,
      });
      await displaySource(host);
      await host
        .getByRole("button", { name: "Share screen", exact: true })
        .click();
      await expect(guest.locator(".screen-tile")).toBeVisible();
      await expect
        .poll(async () => (await received(guest)).screen)
        .toBeGreaterThan(0);
      await expect(guest.locator(".camera-tile")).toHaveCount(2);
      for (const page of [host, guest])
        await toolbarInViewport(page, page === host);
      await guest.screenshot({
        path: `../artifacts/dual-sharing-${viewport.width}.png`,
      });
      for (const page of [host, guest]) {
        await page
          .getByRole("button", { name: "Show chat", exact: true })
          .click();
        await toolbarInViewport(page, page === host);
        await page
          .getByRole("button", { name: "Show participants", exact: true })
          .click();
        await toolbarInViewport(page, page === host);
        await page
          .getByRole("button", { name: "Close participants", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Meeting information", exact: true })
          .click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.keyboard.press("Escape");
        await page
          .getByRole("button", { name: "More meeting controls", exact: true })
          .click();
        await page
          .locator(".meeting-toolbar")
          .getByRole("button", { name: "Invite", exact: true })
          .click();
      }
      await host
        .getByRole("button", { name: "Host Tools", exact: true })
        .click();
      await host
        .getByRole("button", { name: "Close host tools", exact: true })
        .click();
      await host.getByRole("button", { name: "End", exact: true }).click();
      await host.keyboard.press("Escape");
      const continuity = await host.evaluateHandle(() => {
        const probe = window as unknown as Window & {
          __testPeers: RTCPeerConnection[];
          __testSocket: WebSocket;
        };
        return {
          root: document.querySelector(".meeting-room"),
          socket: probe.__testSocket,
          peers: [...probe.__testPeers],
          tracks: probe.__testPeers.flatMap((peer) =>
            peer.getSenders().map((sender) => sender.track),
          ),
          videos: Array.from(document.querySelectorAll("video"), (element) => ({
            element,
            stream: element.srcObject,
          })),
        };
      });
      const fullscreenBefore = await received(guest);
      await toggleMeetingFullscreen(host, true);
      await expect
        .poll(() =>
          host.evaluate(
            () =>
              document.fullscreenElement ===
              document.querySelector(".meeting-room"),
          ),
        )
        .toBe(true);
      await toolbarInViewport(host);
      await fullscreenBounds(host);
      for (const panel of ["participants", "chat"]) {
        await host
          .getByRole("button", { name: `Show ${panel}`, exact: true })
          .click();
        await fullscreenBounds(host);
        await host
          .getByRole("button", { name: `Close ${panel}`, exact: true })
          .click();
      }
      await host.screenshot({
        path: `../artifacts/fullscreen-sharing-${viewport.width}.png`,
      });
      await expect
        .poll(async () => {
          const after = await received(guest);
          return (
            after.camera > fullscreenBefore.camera &&
            after.screen > fullscreenBefore.screen &&
            after.audio > fullscreenBefore.audio
          );
        })
        .toBe(true);
      await toggleMeetingFullscreen(host, false);
      expect(
        await continuity.evaluate((before) => {
          const probe = window as unknown as Window & {
            __testPeers: RTCPeerConnection[];
            __testSocket: WebSocket;
          };
          const tracks = probe.__testPeers.flatMap((peer) =>
            peer.getSenders().map((sender) => sender.track),
          );
          return (
            before.root === document.querySelector(".meeting-room") &&
            before.socket === probe.__testSocket &&
            probe.__testSocket.readyState === WebSocket.OPEN &&
            before.peers.length === probe.__testPeers.length &&
            before.peers.every(
              (peer, index) =>
                peer === probe.__testPeers[index] &&
                peer.connectionState === "connected",
            ) &&
            before.tracks.length === tracks.length &&
            before.tracks.every(
              (track, index) =>
                track === tracks[index] &&
                (!track || track.readyState === "live"),
            ) &&
            before.videos.every(
              ({ element, stream }) =>
                element.isConnected && element.srcObject === stream,
            )
          );
        }),
      ).toBe(true);
      await continuity.dispose();
      await expect
        .poll(() =>
          host.evaluate(
            () =>
              document.fullscreenElement ===
              document.querySelector(".meeting-room"),
          ),
        )
        .toBe(false);
      // A browser's sharing banner reduces viewport height. Intrinsic screen
      // dimensions must not push the stage over the anchored toolbar.
      await host.setViewportSize({ ...viewport, height: 600 });
      await toolbarInViewport(host);
      await host
        .getByRole("button", { name: "Mute microphone", exact: true })
        .click();
      await host
        .getByRole("button", { name: "Unmute microphone", exact: true })
        .click();
      await host
        .getByRole("button", { name: "Stop video", exact: true })
        .click();
      await host
        .getByRole("button", { name: "Start video", exact: true })
        .click();
      const before = await received(guest);
      await expect
        .poll(async () => {
          const after = await received(guest);
          return (
            after.camera > before.camera &&
            after.screen > before.screen &&
            after.audio > before.audio
          );
        })
        .toBe(true);
      await host
        .getByRole("button", { name: "Stop sharing screen", exact: true })
        .click();
      await expect(guest.locator(".screen-tile")).toHaveCount(0);
      await toolbarInViewport(host);
    } finally {
      await room.close();
    }
  });

test("answerer sharing survives viewer rejoin and ICE restart without stale tracks", async ({
  browser,
  request,
}) => {
  const room = await pair(browser, request, { ice_servers: [] });
  try {
    const { host, guest } = room;
    await displaySource(guest);
    await guest
      .getByRole("button", { name: "Share screen", exact: true })
      .click();
    await expect
      .poll(async () => (await received(host)).screen)
      .toBeGreaterThan(0);
    // Rejoin the guest while the host is presenting. The new pair needs both channels.
    await displaySource(host);
    await host
      .getByRole("button", { name: "Share screen", exact: true })
      .click();
    await expect(host.locator(".screen-tile")).toHaveCount(2);
    await guest.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(guest).toHaveURL(new URL("/", FRONTEND).href);
    expect(
      await guest.evaluate(() =>
        (
          window as unknown as { __testPeers: RTCPeerConnection[] }
        ).__testPeers.every((pc) => pc.connectionState === "closed"),
      ),
    ).toBe(true);
    expect(
      await guest.evaluate(
        () =>
          (window as unknown as { __displayTrack: MediaStreamTrack })
            .__displayTrack.readyState,
      ),
    ).toBe("ended");
    await expect(host.locator(".screen-tile:not(.local-tile)")).toHaveCount(0);
    await expect(host.locator(".camera-tile")).toHaveCount(1);
    await guest.goto(`${FRONTEND}/meeting/${room.code}`);
    await guest
      .getByLabel("Your name", { exact: true })
      .fill("RTC guest returned");
    await guest
      .getByRole("button", { name: "Enable camera & microphone", exact: true })
      .click();
    await expect(
      guest.getByRole("button", { name: "Mute microphone", exact: true }),
    ).toBeEnabled();
    await guest
      .getByRole("button", { name: "Join Meeting", exact: true })
      .click();
    await expect
      .poll(async () => (await received(guest)).screen)
      .toBeGreaterThan(0);
    await expect(guest.locator(".camera-tile")).toHaveCount(2);
    const hostId = await host.evaluate(
      () => (window as unknown as { __testSelf: number }).__testSelf,
    );
    const oldUfrag = await guest.evaluate(
      () =>
        (
          window as unknown as { __testPeers: RTCPeerConnection[] }
        ).__testPeers[0].remoteDescription?.sdp.match(/a=ice-ufrag:(.+)/)?.[1],
    );
    await guest.evaluate(
      (target) =>
        (window as unknown as { __testSocket: WebSocket }).__testSocket.send(
          JSON.stringify({ type: "restart-ice", target }),
        ),
      hostId,
    );
    await expect
      .poll(() =>
        guest.evaluate(
          () =>
            (
              window as unknown as { __testPeers: RTCPeerConnection[] }
            ).__testPeers[0].remoteDescription?.sdp.match(
              /a=ice-ufrag:(.+)/,
            )?.[1],
        ),
      )
      .not.toBe(oldUfrag);
    const before = await received(guest);
    await expect
      .poll(async () => {
        const after = await received(guest);
        return (
          after.camera > before.camera &&
          after.screen > before.screen &&
          after.audio > before.audio
        );
      })
      .toBe(true);
    expect(
      await host.evaluate(() =>
        (window as unknown as { __testPeers: RTCPeerConnection[] }).__testPeers
          .filter((pc) => pc.connectionState !== "closed")
          .map((pc) => pc.getTransceivers().length),
      ),
    ).toEqual([3]);
    await host
      .getByRole("button", { name: "Stop sharing screen", exact: true })
      .click();
    await expect(guest.locator(".screen-tile")).toHaveCount(0);
  } finally {
    await room.close();
  }
});

test("leaving while the screen picker is pending releases late capture and peers", async ({
  browser,
  request,
}) => {
  const room = await pair(browser, request, { ice_servers: [] });
  try {
    await room.guest.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = () =>
        new Promise<MediaStream>((resolve) => {
          Object.defineProperty(window, "__resolveDisplay", {
            configurable: true,
            value: resolve,
          });
        });
    });
    await room.guest
      .getByRole("button", { name: "Share screen", exact: true })
      .click();
    await expect(
      room.guest.getByRole("button", { name: "Share screen", exact: true }),
    ).toBeDisabled();
    await room.guest
      .getByRole("button", { name: "Leave", exact: true })
      .click();
    await expect(room.guest).toHaveURL(new URL("/", FRONTEND).href);
    await room.guest.evaluate(() => {
      const canvas = document.createElement("canvas");
      const stream = canvas.captureStream();
      Object.defineProperty(window, "__displayTrack", {
        configurable: true,
        value: stream.getVideoTracks()[0],
      });
      (
        window as unknown as { __resolveDisplay: (stream: MediaStream) => void }
      ).__resolveDisplay(stream);
    });
    await expect
      .poll(() =>
        room.guest.evaluate(
          () =>
            (window as unknown as { __displayTrack: MediaStreamTrack })
              .__displayTrack.readyState,
        ),
      )
      .toBe("ended");
    expect(
      await room.guest.evaluate(() =>
        (
          window as unknown as { __testPeers: RTCPeerConnection[] }
        ).__testPeers.every((pc) => pc.connectionState === "closed"),
      ),
    ).toBe(true);
    await expect(room.host.locator(".screen-tile")).toHaveCount(0);
    await expect(room.host.locator(".camera-tile")).toHaveCount(1);
  } finally {
    await room.close();
  }
});

test("screen sharing sends separate camera and screen video while preserving audio", async ({
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
          let frame = 0;
          const paint = () => {
            if (capture.getVideoTracks()[0].readyState !== "live") return;
            ctx.fillStyle = frame++ % 2 ? "white" : "black";
            ctx.fillRect(20, 20, 30, 30);
            requestAnimationFrame(paint);
          };
          paint();
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
    expect(during.video).toBe(original.video);
    expect(during.state).toBe("connected");
    await expect(guest.locator(".camera-tile")).toHaveCount(2);
    const before = await received(guest);
    await expect
      .poll(async () => {
        const after = await received(guest);
        return (
          after.camera > before.camera &&
          after.screen > before.screen &&
          after.audio > before.audio
        );
      })
      .toBe(true);
    expect(
      await host.evaluate(() => {
        const pc = (window as unknown as { __testPeers: RTCPeerConnection[] })
          .__testPeers[0];
        return {
          channels: pc.getTransceivers().length,
          videos: pc
            .getSenders()
            .filter((sender) => sender.track?.kind === "video").length,
        };
      }),
    ).toEqual({ channels: 3, videos: 2 });
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
    await expect
      .poll(() =>
        host.evaluate(() => {
          const pc = (window as unknown as { __testPeers: RTCPeerConnection[] })
            .__testPeers[0];
          return pc
            .getSenders()
            .filter((sender) => sender.track?.kind === "video").length;
        }),
      )
      .toBe(1);
    expect(
      await host.evaluate(
        () =>
          (window as unknown as { __displayTrack: MediaStreamTrack })
            .__displayTrack.readyState,
      ),
    ).toBe("ended");
    // Sharing works with the camera disabled and preserves that disabled state.
    await host.getByRole("button", { name: "Stop video", exact: true }).click();
    await host
      .getByRole("button", { name: "Share screen", exact: true })
      .click();
    await expect(guest.locator(".screen-tile")).toBeVisible();
    const offBefore = await received(guest);
    await expect
      .poll(async () => {
        const after = await received(guest);
        return after.screen > offBefore.screen && after.audio > offBefore.audio;
      })
      .toBe(true);
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
    await expect(
      room.guest
        .getByRole("complementary", { name: "Participants", exact: true })
        .getByRole("heading"),
    ).toContainText("Participants");
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
    await displaySource(room.host);
    await room.host
      .getByRole("button", { name: "Share screen", exact: true })
      .click();
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
    const recovered = await received(room.guest);
    await expect
      .poll(async () => {
        const after = await received(room.guest);
        return (
          after.camera > recovered.camera &&
          after.screen > recovered.screen &&
          after.audio > recovered.audio
        );
      })
      .toBe(true);
  } finally {
    await room.close();
  }
});

for (const transport of ["udp", "tcp", "tls"] as const)
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
      ).filter((url) =>
        transport === "tls"
          ? /^turns:/.test(url) && !url.includes("transport=udp")
          : /^turn:/.test(url) &&
            (transport === "tcp"
              ? url.includes("transport=tcp")
              : !url.includes("transport=tcp")),
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
        const before = await packets(page);
        await expect
          .poll(
            async () => {
              const after = await packets(page);
              return (
                after.relay &&
                ["audio", "video", "audioOut", "videoOut", "frames"].every(
                  (key) =>
                    after[key as keyof typeof before] >
                    before[key as keyof typeof before],
                )
              );
            },
            { timeout: 30000 },
          )
          .toBe(true);
        const report = await packets(page);
        if (report.relayProtocol) expect(report.relayProtocol).toBe(transport);
        await expect(page.locator(".media-connection")).toHaveAttribute(
          "data-state",
          "connected",
        );
        await expect
          .poll(() =>
            page.locator(".video-tile video").evaluateAll((elements) =>
              elements.some((element) => {
                const video = element as HTMLVideoElement;
                return video.muted && video.videoWidth > 0 && !video.paused;
              }),
            ),
          )
          .toBe(true);
        await expect
          .poll(() =>
            page.locator(".remote-audio audio").evaluateAll((elements) =>
              elements.some((element) => {
                const audio = element as HTMLAudioElement;
                return (
                  !audio.muted &&
                  !audio.paused &&
                  audio.volume === 1 &&
                  (audio.srcObject as MediaStream | null)
                    ?.getAudioTracks()
                    .some((track) => track.readyState === "live")
                );
              }),
            ),
          )
          .toBe(true);
      }
      await displaySource(room.host);
      await room.host
        .getByRole("button", { name: "Share screen", exact: true })
        .click();
      const beforeShare = await received(room.guest);
      await expect
        .poll(
          async () => {
            const after = await received(room.guest);
            return (
              after.camera > beforeShare.camera &&
              after.screen > beforeShare.screen &&
              after.audio > beforeShare.audio &&
              (await packets(room.guest)).relay
            );
          },
          { timeout: 30000 },
        )
        .toBe(true);
      await expect(room.guest.locator(".screen-tile video")).toBeVisible();
      await expect(room.guest.locator(".camera-tile")).toHaveCount(2);
      await room.host
        .getByRole("button", { name: "Stop sharing screen", exact: true })
        .click();
      await expect(room.guest.locator(".screen-tile")).toHaveCount(0);
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
