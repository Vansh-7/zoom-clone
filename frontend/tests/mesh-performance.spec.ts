import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const API = process.env.E2E_API_URL ?? "http://127.0.0.1:8000";
const FRONTEND = process.env.E2E_FRONTEND_URL ?? "http://localhost:3000";
const profiles = [
  { name: "720p30", width: 1280, height: 720, fps: 30 },
  { name: "360p15", width: 640, height: 360, fps: 15 },
];
interface PerformanceProbe {
  peers: RTCPeerConnection[];
  streams: MediaStream[];
  socket?: WebSocket;
  errors: string[];
}
declare global {
  interface Window {
    __meshPerformance: PerformanceProbe;
  }
}

async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const probe = window.__meshPerformance;
    return {
      capture: probe.streams
        .flatMap((stream) => stream.getVideoTracks())
        .filter((track) => track.readyState === "live")
        .map((track) => {
          const { width, height, frameRate } = track.getSettings();
          return { width, height, frameRate };
        }),
      errors: probe.errors,
      peers: await Promise.all(
        probe.peers
          .filter((pc) => pc.connectionState !== "closed")
          .map(async (pc) => {
            const reports = await pc.getStats();
            const totals = {
              receivedAudio: 0,
              sentAudio: 0,
              receivedVideo: 0,
              sentVideo: 0,
              decoded: 0,
              encoded: 0,
              encodeSeconds: 0,
              bytesSent: 0,
              bytesReceived: 0,
              framesDropped: 0,
            };
            let width, height, fps, limitation, rtt, localType;
            reports.forEach((report) => {
              if (
                report.type === "transport" &&
                report.selectedCandidatePairId
              ) {
                const pair = reports.get(report.selectedCandidatePairId);
                rtt = pair?.currentRoundTripTime;
                localType = reports.get(pair?.localCandidateId)?.candidateType;
              }
              if (report.type === "inbound-rtp") {
                if (report.kind === "audio")
                  totals.receivedAudio += report.packetsReceived ?? 0;
                if (report.kind === "video") {
                  totals.receivedVideo += report.packetsReceived ?? 0;
                  totals.decoded += report.framesDecoded ?? 0;
                  totals.bytesReceived += report.bytesReceived ?? 0;
                  totals.framesDropped += report.framesDropped ?? 0;
                }
              }
              if (report.type === "outbound-rtp") {
                if (report.kind === "audio")
                  totals.sentAudio += report.packetsSent ?? 0;
                if (report.kind === "video") {
                  totals.sentVideo += report.packetsSent ?? 0;
                  totals.encoded += report.framesEncoded ?? 0;
                  totals.encodeSeconds += report.totalEncodeTime ?? 0;
                  totals.bytesSent += report.bytesSent ?? 0;
                  width = report.frameWidth;
                  height = report.frameHeight;
                  fps = report.framesPerSecond;
                  limitation = report.qualityLimitationReason;
                }
              }
            });
            return {
              connection: pc.connectionState,
              signaling: pc.signalingState,
              ice: pc.iceConnectionState,
              gathering: pc.iceGatheringState,
              ufrag:
                pc.localDescription?.sdp?.match(/^a=ice-ufrag:(.+)$/m)?.[1],
              localType,
              width,
              height,
              fps,
              limitation,
              rtt,
              ...totals,
            };
          }),
      ),
    };
  });
}

async function healthy(pages: Page[]) {
  await expect
    .poll(
      async () =>
        (await Promise.all(pages.map(snapshot))).every(
          (browser) =>
            browser.peers.length === 3 &&
            browser.peers.every(
              (peer) =>
                peer.connection === "connected" &&
                peer.signaling === "stable" &&
                peer.receivedAudio > 0 &&
                peer.sentAudio > 0 &&
                peer.receivedVideo > 0 &&
                peer.sentVideo > 0 &&
                peer.decoded > 0,
            ),
        ),
      { timeout: 30000 },
    )
    .toBe(true);
}

async function sample(pages: Page[], phase: string) {
  const before = await Promise.all(pages.map(snapshot));
  const start = Date.now();
  await pages[0].waitForTimeout(5000); // A fixed observation interval, not a readiness wait.
  const after = await Promise.all(pages.map(snapshot));
  const seconds = (Date.now() - start) / 1000;
  const pairs = after.flatMap((browser, i) =>
    browser.peers.map((peer, j) => {
      const previous = before[i].peers[j];
      return {
        ...peer,
        encodedFps: (peer.encoded - previous.encoded) / seconds,
        decodedFps: (peer.decoded - previous.decoded) / seconds,
        videoKbpsSent:
          ((peer.bytesSent - previous.bytesSent) * 8) / seconds / 1000,
        encodeMsPerFrame:
          ((peer.encodeSeconds - previous.encodeSeconds) * 1000) /
          Math.max(1, peer.encoded - previous.encoded),
        flowing:
          peer.receivedAudio > previous.receivedAudio &&
          peer.sentAudio > previous.sentAudio &&
          peer.receivedVideo > previous.receivedVideo &&
          peer.sentVideo > previous.sentVideo &&
          peer.decoded > previous.decoded,
      };
    }),
  );
  expect(pairs).toHaveLength(12);
  expect(pairs.every((peer) => peer.flowing)).toBe(true);
  return {
    phase,
    seconds,
    capture: after.map((browser) => browser.capture),
    pairs,
  };
}

test.describe("isolated four-person measurements", () => {
  test.skip(
    process.env.E2E_MESH_PERFORMANCE !== "1",
    "Opt in on a separate four-person test backend; production remains at two.",
  );
  for (const mode of ["720p30", "360p15", "adaptive"] as const) {
    test(`${mode}: capture quality and recovery`, async ({
      browser,
      request,
    }) => {
      test.setTimeout(150000);
      const config = await (await request.get(`${API}/api/rtc-config`)).json();
      test.skip(
        config.max_participants < 4,
        "Requires a separate four-person backend.",
      );
      const profile = profiles[mode === "360p15" ? 1 : 0];
      const created = await (
        await request.post(`${API}/api/meetings/instant`)
      ).json();
      const code = created.meeting.meeting_code;
      const contexts = await Promise.all(
        [0, 1, 2, 3].map(() =>
          browser.newContext({ permissions: ["camera", "microphone"] }),
        ),
      );
      const pages = await Promise.all(
        contexts.map((context) => context.newPage()),
      );
      const observations: unknown[] = [];
      let recoveryMs: number | undefined;
      try {
        for (const page of pages) {
          await page.addInitScript((profile) => {
            window.__meshPerformance = { peers: [], streams: [], errors: [] };
            const capture = navigator.mediaDevices.getUserMedia.bind(
              navigator.mediaDevices,
            );
            navigator.mediaDevices.getUserMedia = async (constraints = {}) => {
              const stream = await capture({
                ...constraints,
                video: constraints.video
                  ? {
                      width: { exact: profile.width },
                      height: { exact: profile.height },
                      frameRate: { ideal: profile.fps, max: profile.fps },
                    }
                  : false,
              });
              window.__meshPerformance.streams.push(stream);
              return stream;
            };
            const Peer = window.RTCPeerConnection;
            window.RTCPeerConnection = class extends Peer {
              constructor(config?: RTCConfiguration) {
                super(config);
                window.__meshPerformance.peers.push(this);
              }
            };
            const Socket = window.WebSocket;
            window.WebSocket = class extends Socket {
              constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols);
                window.__meshPerformance.socket = this;
                this.addEventListener("message", (event) => {
                  const message = JSON.parse(event.data);
                  if (message.type === "error")
                    window.__meshPerformance.errors.push(message.code);
                });
              }
            };
          }, profile);
          await page.route("**/api/rtc-config", (route) =>
            route.fulfill({
              json: { ...config, ice_servers: [], ice_transport_policy: "all" },
            }),
          );
          await page.goto(`${FRONTEND}/meeting/${code}`);
        }
        await pages[0].evaluate(
          ({ code, token }) => localStorage.setItem(`zoom:host:${code}`, token),
          { code, token: created.host_token },
        );
        await pages[0].reload();
        await Promise.all(
          pages.map(async (page, i) => {
            await page
              .getByLabel("Your name", { exact: true })
              .fill(`Performance ${i}`);
            await page
              .getByRole("button", {
                name: "Enable camera & microphone",
                exact: true,
              })
              .click();
            await expect(
              page.getByRole("button", {
                name: "Mute microphone",
                exact: true,
              }),
            ).toBeEnabled();
          }),
        );
        await pages[0]
          .getByRole("button", { name: "Start Meeting", exact: true })
          .click();
        await Promise.all(
          pages
            .slice(1)
            .map((page) =>
              page
                .getByRole("button", { name: "Join Meeting", exact: true })
                .click(),
            ),
        );
        await healthy(pages);
        observations.push(await sample(pages, "baseline"));
        const before = await Promise.all(pages.map(snapshot));
        if (mode === "adaptive") {
          // Test capture adaptation separately from ICE: no restart, track replacement, or new SDP.
          await Promise.all(
            pages.map((page) =>
              page.evaluate(async () => {
                for (const stream of window.__meshPerformance.streams)
                  for (const track of stream
                    .getVideoTracks()
                    .filter((track) => track.readyState === "live"))
                    await track.applyConstraints({
                      width: { exact: 640 },
                      height: { exact: 360 },
                      frameRate: { max: 15 },
                    });
              }),
            ),
          );
          await healthy(pages);
          observations.push(await sample(pages, "reduced-360p15"));
          const after = await Promise.all(pages.map(snapshot));
          for (const [i, state] of after.entries()) {
            expect(state.capture[0].width).toBe(640);
            expect(state.capture[0].height).toBe(360);
            expect(state.peers.map((peer) => peer.ufrag)).toEqual(
              before[i].peers.map((peer) => peer.ufrag),
            );
          }
        } else {
          const start = Date.now();
          await Promise.all(
            pages.map(async (page) => {
              const ids = await page
                .locator(".video-tile:not(.local-tile)")
                .evaluateAll((tiles) =>
                  tiles.map((tile) =>
                    Number((tile as HTMLElement).dataset.participantId),
                  ),
                );
              await page.evaluate(
                (ids) =>
                  ids.forEach((target) =>
                    window.__meshPerformance.socket!.send(
                      JSON.stringify({ type: "restart-ice", target }),
                    ),
                  ),
                ids,
              );
            }),
          );
          await expect
            .poll(
              async () =>
                (await Promise.all(pages.map(snapshot))).every((state, i) =>
                  state.peers.every(
                    (peer, j) => peer.ufrag !== before[i].peers[j].ufrag,
                  ),
                ),
              { timeout: 30000 },
            )
            .toBe(true);
          await healthy(pages);
          recoveryMs = Date.now() - start;
          observations.push(await sample(pages, "after-ice-restart"));
        }
      } finally {
        const report = {
          mode,
          repeat: test.info().repeatEachIndex,
          recoveryMs,
          observations,
          final: await Promise.allSettled(pages.map(snapshot)),
        };
        const folder = path.resolve("../artifacts");
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(
          path.join(
            folder,
            `mesh-performance-${mode}-${test.info().repeatEachIndex}.json`,
          ),
          JSON.stringify(report, null, 2),
        );
        await test.info().attach("mesh-performance", {
          body: JSON.stringify(report),
          contentType: "application/json",
        });
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
});
