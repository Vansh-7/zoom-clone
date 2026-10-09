import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";

const API = process.env.E2E_API_URL ?? "http://127.0.0.1:8000";
const FRONTEND = process.env.E2E_FRONTEND_URL ?? "http://localhost:3000";

interface Probe {
  peers: RTCPeerConnection[];
  streams: MediaStream[];
  sockets: WebSocket[];
  selfId?: number;
  errors: string[];
  signals: { type: string; sender?: number; target?: number; ufrag?: string }[];
  screen?: MediaStreamTrack;
  blockMedia?: boolean;
  blockedTargets?: number[];
}
declare global {
  interface Window {
    __mesh: Probe;
  }
}

async function instrument(page: Page) {
  await page.addInitScript(() => {
    window.__mesh = {
      peers: [],
      streams: [],
      sockets: [],
      errors: [],
      signals: [],
    };
    const record = (message: {
      type: string;
      sender?: number;
      target?: number;
      payload?: { sdp?: string };
    }) => {
      if (["offer", "answer", "restart-ice"].includes(message.type))
        window.__mesh.signals.push({
          type: message.type,
          sender: message.sender,
          target: message.target,
          ufrag: message.payload?.sdp
            ?.match(/^a=ice-ufrag:(.+)$/m)?.[1]
            ?.trim(),
        });
    };
    const Original = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Original {
      constructor(configuration?: RTCConfiguration) {
        super(configuration);
        window.__mesh.peers.push(this);
      }
    };
    const getMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      // Bound the synthetic encoder load when four browsers share one test machine.
      const stream = await getMedia({
        ...constraints,
        video: constraints?.video
          ? {
              width: { exact: 640 },
              height: { exact: 360 },
              frameRate: { max: 15 },
            }
          : false,
      });
      window.__mesh.streams.push(stream);
      return stream;
    };
    const Socket = window.WebSocket;
    window.WebSocket = class extends Socket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        window.__mesh.sockets.push(this);
        this.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);
          if (message.type === "welcome")
            window.__mesh.selfId = message.self_id;
          if (message.type === "error") window.__mesh.errors.push(message.code);
          record(message);
        });
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === "string") {
          const message = JSON.parse(data);
          record(message);
          if (
            (window.__mesh.blockMedia ||
              window.__mesh.blockedTargets?.includes(message.target)) &&
            message.payload
          ) {
            if (message.type === "candidate" && message.payload.candidate)
              message.payload.candidate = message.payload.candidate.replace(
                /^(candidate:\S+ \d+ \S+ \d+) \S+ \d+/,
                "$1 203.0.113.1 50000",
              );
            if (message.payload.sdp)
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
  });
}

test("a connected third participant cannot hide another peer's ICE failure", async ({
  browser,
  request,
}) => {
  test.setTimeout(90000);
  const config = await (await request.get(`${API}/api/rtc-config`)).json();
  test.skip(
    config.max_participants < 3,
    "Requires a dedicated three-person backend.",
  );
  const created = await (
    await request.post(`${API}/api/meetings/instant`)
  ).json();
  const code = created.meeting.meeting_code;
  const contexts = await Promise.all(
    [0, 1, 2].map(() =>
      browser.newContext({ permissions: ["camera", "microphone"] }),
    ),
  );
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const [host, blocked, healthyGuest] = pages;
  try {
    for (const page of pages) {
      await instrument(page);
      await page.route("**/api/rtc-config", (route) =>
        route.fulfill({
          json: { ice_servers: [], ice_transport_policy: "all" },
        }),
      );
      await page.goto(`${FRONTEND}/meeting/${code}`);
    }
    await host.evaluate(
      ({ code, token }) => localStorage.setItem(`zoom:host:${code}`, token),
      { code, token: created.host_token },
    );
    await host.reload();
    for (const [index, page] of pages.entries()) {
      await page
        .getByLabel("Your name", { exact: true })
        .fill(`Recovery ${index}`);
      await page
        .getByRole("button", {
          name: "Enable camera & microphone",
          exact: true,
        })
        .click();
      if (index < 2) {
        await page.evaluate(() => {
          window.__mesh.blockMedia = true;
        });
        await page
          .getByRole("button", {
            name: index === 0 ? "Start Meeting" : "Join Meeting",
            exact: true,
          })
          .click();
        await expect(page.locator(".room-connection")).toContainText(
          "Connected",
        );
      }
    }
    await expect
      .poll(
        () =>
          host.evaluate(() =>
            window.__mesh.peers.some((pc) => pc.connectionState === "failed"),
          ),
        { timeout: 35000 },
      )
      .toBe(true);
    await expect(host.locator(".room-error")).toContainText(
      "ICE could not establish",
    );
    for (const page of [host, blocked])
      await page.evaluate(() => {
        window.__mesh.blockMedia = false;
      });
    await healthyGuest
      .getByRole("button", { name: "Join Meeting", exact: true })
      .click();
    for (const page of [host, blocked]) {
      await expect
        .poll(() =>
          page
            .locator('video[aria-label="Recovery 2 video"]')
            .evaluate((video: HTMLVideoElement) => video.videoWidth),
        )
        .toBeGreaterThan(0);
      expect(
        await page.evaluate(() =>
          window.__mesh.peers.some((pc) => pc.connectionState === "failed"),
        ),
      ).toBe(true);
      await expect(page.locator(".room-error")).toContainText(
        "ICE could not establish",
      );
    }
    await blocked.getByRole("button", { name: "Leave", exact: true }).click();
    await healthy([host, healthyGuest]);
    await growing([host, healthyGuest]);
  } finally {
    await request
      .post(`${API}/api/meetings/${code}/end`, {
        timeout: 5000,
        headers: { Authorization: `Bearer ${created.host_token}` },
      })
      .catch(() => {});
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
});

async function stats(page: Page) {
  return page.evaluate(async () =>
    Promise.all(
      window.__mesh.peers
        .filter((pc) => pc.connectionState !== "closed")
        .map(async (pc) => {
          const reports = await pc.getStats();
          let localType: string | undefined;
          const totals = {
            incomingAudio: 0,
            outgoingAudio: 0,
            incomingVideo: 0,
            outgoingVideo: 0,
            decoded: 0,
          };
          reports.forEach((item) => {
            if (item.type === "transport" && item.selectedCandidatePairId) {
              const pair = reports.get(item.selectedCandidatePairId);
              localType = reports.get(pair?.localCandidateId)?.candidateType;
            }
            if (item.type === "inbound-rtp" && item.kind === "audio")
              totals.incomingAudio += item.packetsReceived ?? 0;
            if (item.type === "outbound-rtp" && item.kind === "audio")
              totals.outgoingAudio += item.packetsSent ?? 0;
            if (item.type === "inbound-rtp" && item.kind === "video") {
              totals.incomingVideo += item.packetsReceived ?? 0;
              totals.decoded += item.framesDecoded ?? 0;
            }
            if (item.type === "outbound-rtp" && item.kind === "video")
              totals.outgoingVideo += item.packetsSent ?? 0;
          });
          return {
            policy: pc.getConfiguration().iceTransportPolicy,
            localType,
            state: pc.connectionState,
            signaling: pc.signalingState,
            ufrag: pc.localDescription?.sdp?.match(/^a=ice-ufrag:(.+)$/m)?.[1],
            ...totals,
          };
        }),
    ),
  );
}

async function healthy(pages: Page[]) {
  await Promise.all(
    pages.map(async (page) => {
      await expect(page.locator(".video-tile")).toHaveCount(pages.length);
      await expect
        .poll(async () => {
          const peers = await stats(page);
          return (
            peers.length === pages.length - 1 &&
            peers.every(
              (peer) =>
                peer.state === "connected" &&
                (peer.policy !== "relay" || peer.localType === "relay") &&
                peer.signaling === "stable" &&
                peer.incomingAudio > 0 &&
                peer.outgoingAudio > 0 &&
                peer.incomingVideo > 0 &&
                peer.outgoingVideo > 0 &&
                peer.decoded > 0,
            )
          );
        })
        .toBe(true);
      await expect
        .poll(() =>
          page
            .locator(".video-tile:not(.local-tile) video")
            .evaluateAll((videos) =>
              videos.every((element) => {
                const video = element as HTMLVideoElement;
                return (
                  video.readyState >= 2 && video.videoWidth > 0 && !video.paused
                );
              }),
            ),
        )
        .toBe(true);
      await expect(page.locator(".room-error")).toHaveCount(0);
    }),
  );
}

async function growing(pages: Page[]) {
  const before = await Promise.all(pages.map(stats));
  await expect
    .poll(async () => {
      const after = await Promise.all(pages.map(stats));
      return after.every(
        (peers, i) =>
          peers.length === before[i].length &&
          peers.every(
            (peer, j) =>
              peer.incomingAudio > before[i][j].incomingAudio &&
              peer.outgoingAudio > before[i][j].outgoingAudio &&
              peer.incomingVideo > before[i][j].incomingVideo &&
              peer.outgoingVideo > before[i][j].outgoingVideo &&
              peer.decoded > before[i][j].decoded,
          ),
      );
    })
    .toBe(true);
}

async function sendCommand(page: Page, type: string, target?: number) {
  await page.evaluate(
    ({ type, target }) => {
      window.__mesh.sockets
        .find((socket) => socket.readyState === WebSocket.OPEN)!
        .send(JSON.stringify({ type, target }));
    },
    { type, target },
  );
}

async function released(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__mesh.peers.every((pc) => pc.connectionState === "closed") &&
          window.__mesh.streams.every((stream) =>
            stream.getTracks().every((track) => track.readyState === "ended"),
          ) &&
          window.__mesh.sockets.every(
            (socket) => socket.readyState === WebSocket.CLOSED,
          ) &&
          (!window.__mesh.screen ||
            window.__mesh.screen.readyState === "ended"),
      ),
    )
    .toBe(true);
}

test("four peers recover simultaneous failed host pairs while guest media continues", async ({
  browser,
  request,
}) => {
  test.setTimeout(120000);
  const config = await (await request.get(`${API}/api/rtc-config`)).json();
  test.skip(
    config.max_participants < 4,
    "Requires an isolated four-person backend.",
  );
  const created = await (
    await request.post(`${API}/api/meetings/instant`)
  ).json();
  const code = created.meeting.meeting_code;
  const contexts = await Promise.all(
    Array.from({ length: 4 }, () =>
      browser.newContext({ permissions: ["camera", "microphone"] }),
    ),
  );
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const [host, ...guests] = pages;
  for (const page of pages) page.setDefaultTimeout(15000);
  try {
    for (const page of pages) {
      await instrument(page);
      await page.route("**/api/rtc-config", (route) =>
        route.fulfill({
          json: { ...config, ice_servers: [], ice_transport_policy: "all" },
        }),
      );
    }
    await host.goto(FRONTEND);
    await host.evaluate(
      ({ code, token }) => localStorage.setItem(`zoom:host:${code}`, token),
      { code, token: created.host_token },
    );
    await Promise.all(
      pages.map(async (page, i) => {
        await page.goto(`${FRONTEND}/meeting/${code}`);
        await page.getByLabel("Your name").fill(`Recovery ${i}`);
        await page
          .getByRole("button", {
            name: "Enable camera & microphone",
            exact: true,
          })
          .click();
        await expect(
          page.getByRole("button", { name: "Mute microphone", exact: true }),
        ).toBeEnabled();
      }),
    );
    await host.evaluate(() => {
      window.__mesh.blockMedia = true;
    });
    await host
      .getByRole("button", { name: "Start Meeting", exact: true })
      .click();
    await expect
      .poll(() => host.evaluate(() => window.__mesh.selfId))
      .toBeTruthy();
    const hostId = await host.evaluate(() => window.__mesh.selfId!);
    await Promise.all(
      guests.map(async (guest) => {
        await guest.evaluate((id) => {
          window.__mesh.blockedTargets = [id];
        }, hostId);
        await guest
          .getByRole("button", { name: "Join Meeting", exact: true })
          .click();
      }),
    );
    await expect
      .poll(
        async () => {
          const states = await Promise.all(pages.map(stats));
          return (
            states[0].length === 3 &&
            states[0].every((peer) => peer.state === "failed") &&
            states
              .slice(1)
              .every(
                (peers) =>
                  peers.filter((peer) => peer.state === "connected").length ===
                    2 &&
                  peers.filter((peer) => peer.state === "failed").length === 1,
              )
          );
        },
        { timeout: 60000 },
      )
      .toBe(true);
    for (const page of pages) {
      await expect(page.locator(".room-connection")).toContainText("Connected");
      await expect(page.locator(".room-error")).toContainText(
        "ICE could not establish",
      );
    }
    const before = await Promise.all(
      guests.map(async (page) =>
        (await stats(page)).filter((peer) => peer.state === "connected"),
      ),
    );
    await expect
      .poll(async () =>
        (
          await Promise.all(
            guests.map(async (page) =>
              (await stats(page)).filter((peer) => peer.state === "connected"),
            ),
          )
        ).every(
          (peers, i) =>
            peers.length === 2 &&
            peers.every(
              (peer, j) =>
                peer.incomingAudio > before[i][j].incomingAudio &&
                peer.outgoingAudio > before[i][j].outgoingAudio &&
                peer.decoded > before[i][j].decoded,
            ),
        ),
      )
      .toBe(true);
    await Promise.all(
      pages.map(async (page) => {
        await page.evaluate(() => {
          window.__mesh.blockMedia = false;
          window.__mesh.blockedTargets = [];
        });
        await page
          .getByRole("button", { name: "Retry media connection", exact: true })
          .click();
      }),
    );
    await healthy(pages);
    await growing(pages);
    expect(
      await Promise.all(
        pages.map((page) => page.evaluate(() => window.__mesh.errors)),
      ),
    ).toEqual([[], [], [], []]);
    await host.getByRole("button", { name: "End", exact: true }).click();
    await host
      .getByRole("button", { name: "End Meeting for All", exact: true })
      .click();
    await Promise.all(pages.map(released));
  } catch (error) {
    await test.info().attach("failed-pairs", {
      body: JSON.stringify(
        await Promise.allSettled(
          pages.map(async (page) => ({
            peers: (await stats(page)).map(({ ufrag: _ufrag, ...peer }) => {
              void _ufrag;
              return peer;
            }),
            errors: await page.evaluate(() => window.__mesh.errors),
            notices: await page.locator(".room-error").allTextContents(),
          })),
        ),
      ),
      contentType: "application/json",
    });
    throw error;
  } finally {
    await request
      .post(`${API}/api/meetings/${code}/end`, {
        timeout: 5000,
        headers: { Authorization: `Bearer ${created.host_token}` },
      })
      .catch(() => {});
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
});

for (const count of [3, 4]) {
  test(`${count}-person mesh: every media pair, sharing, controls, churn, and cleanup`, async ({
    browser,
    request,
  }) => {
    test.setTimeout(120000);
    const config = await (await request.get(`${API}/api/rtc-config`)).json();
    test.skip(
      config.max_participants < count,
      `Requires a dedicated backend with MAX_PARTICIPANTS>=${count}; production remains at two.`,
    );
    const created = await (
      await request.post(`${API}/api/meetings/instant`)
    ).json();
    const code = created.meeting.meeting_code;
    const errors: string[] = [];
    const contexts = await Promise.all(
      Array.from({ length: count }, () =>
        browser.newContext({ permissions: ["camera", "microphone"] }),
      ),
    );
    const pages = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    const [host, ...guests] = pages;
    const rtc = process.env.E2E_RTC_CONFIG_FILE
      ? JSON.parse(fs.readFileSync(process.env.E2E_RTC_CONFIG_FILE, "utf8"))
      : { ice_servers: [], ice_transport_policy: "all" };
    for (const page of pages) {
      page.on("pageerror", (error) => errors.push(error.message));
      await instrument(page);
      await page.route("**/api/rtc-config", (route) =>
        route.fulfill({
          json: { ...config, ...rtc },
        }),
      );
    }
    const prepare = async (page: Page, index: number) => {
      await page.goto(`${FRONTEND}/meeting/${code}`);
      await page.getByLabel("Your name", { exact: true }).fill(`Mesh ${index}`);
      await page
        .getByRole("button", {
          name: "Enable camera & microphone",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("button", { name: "Mute microphone", exact: true }),
      ).toBeEnabled();
    };
    const enter = async (page: Page, host = false) => {
      await page
        .getByRole("button", {
          name: host ? "Start Meeting" : "Join Meeting",
          exact: true,
        })
        .click();
      await expect(page.locator(".room-connection")).toContainText("Connected");
    };
    try {
      await host.goto(FRONTEND);
      await host.evaluate(
        ({ code, token }) => localStorage.setItem(`zoom:host:${code}`, token),
        { code, token: created.host_token },
      );
      await Promise.all(pages.map(prepare));
      await enter(host, true);
      await Promise.all(guests.map((page) => enter(page)));
      await healthy(pages);
      await growing(pages);

      if (count === config.max_participants) {
        const full = await request.post(`${API}/api/meetings/${code}/join`, {
          data: { display_name: "Overflow guest" },
        });
        expect(full.status()).toBe(409);
        expect((await full.json()).error.code).toBe("MEETING_FULL");
      }
      // Restarts requested concurrently from both sides must retain one offer owner per pair.
      const beforeRestart = await Promise.all(pages.map(stats));
      await Promise.all(
        pages.map(async (page) => {
          const ids = await page
            .locator(".video-tile:not(.local-tile)")
            .evaluateAll((tiles) =>
              tiles.map((tile) =>
                Number((tile as HTMLElement).dataset.participantId),
              ),
            );
          for (const id of ids) await sendCommand(page, "restart-ice", id);
        }),
      );
      await expect
        .poll(async () => {
          const after = await Promise.all(pages.map(stats));
          return after.every((peers, i) =>
            peers.every((peer, j) => peer.ufrag !== beforeRestart[i][j].ufrag),
          );
        })
        .toBe(true);
      await healthy(pages);
      await growing(pages);

      await Promise.all(
        pages.map(async (page, i) => {
          await page
            .getByRole("button", { name: "Show chat", exact: true })
            .click();
          await page
            .getByLabel("Message everyone")
            .fill(`Mesh ${i} says hello ${code}`);
          await page.getByRole("button", { name: "Send", exact: true }).click();
        }),
      );
      for (const page of pages)
        for (let i = 0; i < count; i++)
          await expect(
            page.getByText(`Mesh ${i} says hello ${code}`, { exact: true }),
          ).toBeVisible();

      const hostId = await host.evaluate(() => window.__mesh.selfId!);
      await sendCommand(guests[0], "mute-all");
      await sendCommand(guests[0], "remove-participant", hostId);
      await expect
        .poll(() =>
          guests[0].evaluate(
            () =>
              window.__mesh.errors.filter((code) => code === "HOST_REQUIRED")
                .length,
          ),
        )
        .toBe(2);
      expect(
        (await request.post(`${API}/api/meetings/${code}/end`)).status(),
      ).toBe(403);
      await expect(
        host.getByRole("button", { name: "Mute microphone", exact: true }),
      ).toBeVisible();
      await guests[0]
        .getByRole("button", { name: "Retry media connection", exact: true })
        .click();
      await healthy(pages);

      await host
        .getByRole("button", { name: "Show participants", exact: true })
        .click();
      await host.getByRole("button", { name: "Mute All", exact: true }).click();
      for (const guest of guests) {
        await expect(
          guest.getByRole("button", { name: "Unmute microphone", exact: true }),
        ).toBeVisible();
        expect(
          await guest.evaluate(() =>
            window.__mesh.peers
              .filter((pc) => pc.connectionState === "connected")
              .every(
                (pc) =>
                  pc
                    .getSenders()
                    .find((sender) => sender.track?.kind === "audio")?.track
                    ?.enabled === false,
              ),
          ),
        ).toBe(true);
      }
      await Promise.all(
        guests.map((page) =>
          page
            .getByRole("button", { name: "Unmute microphone", exact: true })
            .click(),
        ),
      );
      await guests[0]
        .getByRole("button", { name: "Stop video", exact: true })
        .click();
      for (const page of pages.filter((page) => page !== guests[0]))
        await expect(
          page
            .locator(".video-tile")
            .filter({ hasText: "Mesh 1" })
            .locator(".tile-placeholder"),
        ).toBeVisible();
      await guests[0]
        .getByRole("button", { name: "Start video", exact: true })
        .click();
      await growing(pages);

      const leaving = guests.at(-1)!;
      await leaving.getByRole("button", { name: "Leave", exact: true }).click();
      const remaining = pages.filter((page) => page !== leaving);
      // A same-document route keeps our probes available for cleanup assertions.
      await expect(leaving).toHaveURL(new URL("/", FRONTEND).href);
      await released(leaving);
      await healthy(remaining);
      await growing(remaining);

      const cameraIds = await host.evaluate(() =>
        window.__mesh.peers
          .filter((pc) => pc.connectionState === "connected")
          .map((pc) => ({
            audio: pc.getSenders().find((s) => s.track?.kind === "audio")?.track
              ?.id,
            video: pc.getSenders().find((s) => s.track?.kind === "video")?.track
              ?.id,
          })),
      );
      await host.evaluate(() => {
        navigator.mediaDevices.getDisplayMedia = async () => {
          const canvas = document.createElement("canvas");
          canvas.width = 640;
          canvas.height = 360;
          const context = canvas.getContext("2d")!;
          context.fillStyle = "#1565e0";
          context.fillRect(0, 0, 640, 360);
          const stream = canvas.captureStream(15);
          window.__mesh.screen = stream.getVideoTracks()[0];
          let frame = 0;
          const paint = () => {
            if (stream.getVideoTracks()[0].readyState !== "live") return;
            context.fillStyle = frame++ % 2 ? "white" : "black";
            context.fillRect(100, 100, 20, 20);
            requestAnimationFrame(paint);
          };
          paint();
          return stream;
        };
      });
      await host
        .getByRole("button", { name: "Share screen", exact: true })
        .click();
      // Rejoin while sharing, so a newly negotiated pair must get the screen track.
      await prepare(leaving, count - 1);
      await enter(leaving);
      await healthy(pages);
      for (const guest of guests) {
        await expect(guest.locator(".screen-tile")).toContainText("Mesh 0");
        await expect
          .poll(() =>
            guest
              .locator(".screen-tile video")
              .evaluate((element: HTMLVideoElement) => {
                const canvas = document.createElement("canvas");
                canvas.width = 1;
                canvas.height = 1;
                const context = canvas.getContext("2d")!;
                context.drawImage(element, 0, 0, 1, 1);
                const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
                return b > 150 && b > r * 2 && g > 50;
              }),
          )
          .toBe(true);
      }
      expect(
        await host.evaluate(() =>
          window.__mesh.peers
            .filter((pc) => pc.connectionState === "connected")
            .every(
              (pc) =>
                pc.getSenders().find((sender) => sender.track?.kind === "video")
                  ?.track?.id === window.__mesh.screen?.id,
            ),
        ),
      ).toBe(true);
      const sharingIds = await host.evaluate(() =>
        window.__mesh.peers
          .filter((pc) => pc.connectionState === "connected")
          .map(
            (pc) =>
              pc.getSenders().find((s) => s.track?.kind === "audio")?.track?.id,
          ),
      );
      expect(sharingIds.slice(0, cameraIds.length)).toEqual(
        cameraIds.map((pair) => pair.audio),
      );
      await growing(pages);
      await host
        .getByRole("button", { name: "Stop sharing screen", exact: true })
        .click();
      for (const guest of guests)
        await expect(guest.locator(".screen-tile")).toHaveCount(0);
      expect(
        await host.evaluate(
          (original) =>
            window.__mesh.peers
              .filter((pc) => pc.connectionState === "connected")
              .every(
                (pc) =>
                  pc.getSenders().find((s) => s.track?.kind === "video")?.track
                    ?.id === original,
              ),
          cameraIds[0].video,
        ),
      ).toBe(true);
      await growing(pages);

      await host
        .getByRole("button", { name: `Remove Mesh ${count - 1}`, exact: true })
        .click();
      await host
        .getByRole("button", { name: "Remove Participant", exact: true })
        .click();
      await expect(
        leaving.getByRole("heading", {
          name: "The host removed you from this meeting.",
          exact: true,
        }),
      ).toBeVisible();
      await released(leaving);
      await healthy(remaining);
      await growing(remaining);
      // Closing a tab must drop only its own three peer connections.
      let active = remaining;
      if (count === 4) {
        await contexts[1].close();
        active = remaining.filter((page) => page !== guests[0]);
        await healthy(active);
        await growing(active);
      }
      await host.getByRole("button", { name: "End", exact: true }).click();
      await host
        .getByRole("button", { name: "End Meeting for All", exact: true })
        .click();
      for (const guest of active.filter((page) => page !== host))
        await expect(
          guest.getByRole("heading", {
            name: "This meeting has ended.",
            exact: true,
          }),
        ).toBeVisible();
      await Promise.all(pages.filter((page) => !page.isClosed()).map(released));
      expect(errors).toEqual([]);
    } catch (error) {
      await test.info().attach("mesh-state.json", {
        body: JSON.stringify(
          await Promise.allSettled(
            pages.map(async (page) => ({
              url: page.url(),
              peers: await stats(page),
              errors: await page.evaluate(() => window.__mesh.errors),
              signals: await page.evaluate(() => window.__mesh.signals),
              notice: await page.locator(".room-error").allTextContents(),
            })),
          ),
          null,
          2,
        ),
        contentType: "application/json",
      });
      throw error;
    } finally {
      await request
        .post(`${API}/api/meetings/${code}/end`, {
          timeout: 5000,
          headers: { Authorization: `Bearer ${created.host_token}` },
        })
        .catch(() => {});
      await Promise.allSettled(contexts.map((context) => context.close()));
    }
  });
}
