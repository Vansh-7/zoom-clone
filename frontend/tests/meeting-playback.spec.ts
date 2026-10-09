import { toggleMeetingFullscreen } from "./helpers/fullscreen";
import { test, expect, type Page } from "@playwright/test";

const API = process.env.E2E_API_URL ?? "http://127.0.0.1:8000";
const FRONTEND = process.env.E2E_FRONTEND_URL ?? "http://localhost:3000";
test.use({ trace: "off" });

async function smallCamera(page: Page) {
  await page.addInitScript(() => {
    if (!navigator.mediaDevices?.getUserMedia) return;
    const get = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = (constraints) =>
      get({
        ...constraints,
        video: constraints?.video
          ? { width: 640, height: 360, frameRate: 15 }
          : false,
      });
  });
}

async function galleryBounds(page: Page, count: number) {
  await expect(page.locator(".video-grid .camera-tile")).toHaveCount(count);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const header = document
          .querySelector(".room-header")!
          .getBoundingClientRect();
        const toolbar = document
          .querySelector(".meeting-toolbar")!
          .getBoundingClientRect();
        const stage = document
          .querySelector(".meeting-stage")!
          .getBoundingClientRect();
        const media = document
          .querySelector(".stage-media")!
          .getBoundingClientRect();
        const grid = document
          .querySelector(".video-grid")!
          .getBoundingClientRect();
        const tiles = Array.from(
          document.querySelectorAll(".video-grid .video-tile"),
          (tile) => tile.getBoundingClientRect(),
        );
        return (
          toolbar.bottom <= innerHeight + 1 &&
          (grid.width >= media.width - 2 || grid.height >= media.height - 2) &&
          tiles.every(
            (tile, i) =>
              tile.width > 0 &&
              tile.height > 0 &&
              tile.top >= header.bottom - 1 &&
              tile.bottom <= toolbar.top + 1 &&
              tile.top >= stage.top - 1 &&
              tile.bottom <= stage.bottom + 1 &&
              tile.left >= stage.left - 1 &&
              tile.right <= stage.right + 1 &&
              tiles.every(
                (other, j) =>
                  i === j ||
                  tile.right <= other.left + 1 ||
                  tile.left >= other.right - 1 ||
                  tile.bottom <= other.top + 1 ||
                  tile.top >= other.bottom - 1,
              ),
          )
        );
      }),
    )
    .toBe(true);
  if (count === 4) {
    const tiles = await page
      .locator(".video-grid .video-tile")
      .evaluateAll((elements) =>
        elements.map((element) => ({
          x: element.getBoundingClientRect().x,
          y: element.getBoundingClientRect().y,
        })),
      );
    expect(Math.abs(tiles[0].y - tiles[1].y)).toBeLessThan(1);
    expect(Math.abs(tiles[2].y - tiles[3].y)).toBeLessThan(1);
    expect(tiles[2].y).toBeGreaterThan(tiles[0].y);
    expect(Math.abs(tiles[0].x - tiles[2].x)).toBeLessThan(1);
  }
  {
    const ratios = await page
      .locator(".video-grid .video-tile")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.width / bounds.height;
        }),
      );
    ratios.forEach((ratio) =>
      expect(Math.abs(ratio - 16 / 9)).toBeLessThan(0.06),
    );
  }
}

test("meeting gallery fits its allocated canvas with 1-4 participants, panels and resizing", async ({
  browser,
  request,
  browserName,
}) => {
  test.setTimeout(120000);
  const created = await (
    await request.post(`${API}/api/meetings/instant`)
  ).json();
  const code = created.meeting.meeting_code;
  const contexts = await Promise.all(
    Array.from({ length: 4 }, () => browser.newContext()),
  );
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const host = pages[0];
  try {
    await host.goto(FRONTEND);
    await host.evaluate(
      ({ code, token }) => localStorage.setItem(`zoom:host:${code}`, token),
      { code, token: created.host_token },
    );
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index];
      if (browserName === "chromium") await smallCamera(page);
      await page.goto(`${FRONTEND}/meeting/${code}`);
      await page
        .getByLabel("Your name", { exact: true })
        .fill(`Gallery ${index}`);
      if (browserName === "chromium")
        await page
          .getByRole("button", {
            name: "Enable camera & microphone",
            exact: true,
          })
          .click();
      await page
        .getByRole("button", {
          name: index === 0 ? "Start Meeting" : "Join Meeting",
          exact: true,
        })
        .click();
      await expect(host.locator(".video-grid .camera-tile")).toHaveCount(
        index + 1,
      );
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 1440, height: 600 },
        { width: 768, height: 1024 },
        { width: 768, height: 600 },
        { width: 390, height: 844 },
        { width: 390, height: 600 },
        { width: 844, height: 390 },
      ]) {
        await host.setViewportSize(viewport);
        await galleryBounds(host, index + 1);
        await host
          .getByRole("button", { name: "Show participants", exact: true })
          .click();
        await galleryBounds(host, index + 1);
        await host
          .getByRole("button", { name: "Close participants", exact: true })
          .click();
        await host
          .getByRole("button", { name: "Show chat", exact: true })
          .click();
        await galleryBounds(host, index + 1);
        await host
          .getByRole("button", { name: "Close chat", exact: true })
          .click();
        if (viewport.height > 600)
          await host.screenshot({
            path: `../artifacts/gallery-${browserName}-${index + 1}-${viewport.width}.png`,
          });
      }
    }
    if (browserName === "chromium") {
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
      await galleryBounds(host, 4);
      await toggleMeetingFullscreen(host, false);
    }
  } finally {
    await request.post(`${API}/api/meetings/${code}/end`, {
      headers: { Authorization: `Bearer ${created.host_token}` },
    });
    await Promise.all(contexts.map((context) => context.close()));
  }
});

type PlaybackProbe = {
  peers: RTCPeerConnection[];
  pending: (() => void)[];
  releaseAudio: boolean;
  blockAudio: boolean;
  gesturePlays: number;
  element?: HTMLAudioElement;
};
type PlaybackWindow = Window & { __playback: PlaybackProbe };
declare global {
  interface Window {
    __playback: PlaybackProbe;
  }
}

async function audioPackets(page: Page) {
  return page.evaluate(async () => {
    const result = { incoming: 0, outgoing: 0, frames: 0 };
    for (const peer of (window as PlaybackWindow).__playback.peers) {
      const stats = await peer.getStats();
      stats.forEach((stat) => {
        if (stat.type === "inbound-rtp" && stat.kind === "audio")
          result.incoming += stat.packetsReceived ?? 0;
        if (stat.type === "outbound-rtp" && stat.kind === "audio")
          result.outgoing += stat.packetsSent ?? 0;
        if (stat.type === "inbound-rtp" && stat.kind === "video")
          result.frames += stat.framesDecoded ?? 0;
      });
    }
    return result;
  });
}

test("remote audio handles late tracks, blocked autoplay and sharing without duplicate playback", async ({
  browser,
  page,
  request,
  browserName,
}) => {
  await page.goto(FRONTEND);
  const supported = await page.evaluate(
    () =>
      typeof RTCPeerConnection !== "undefined" &&
      typeof MediaStream !== "undefined",
  );
  test.skip(
    !supported,
    "This installed browser engine does not provide WebRTC or MediaStream.",
  );
  test.skip(
    browserName !== "chromium",
    "Synthetic microphone/camera capture is available only in this Chromium test setup.",
  );
  const created = await (
    await request.post(`${API}/api/meetings/instant`)
  ).json();
  const code = created.meeting.meeting_code;
  const contexts = await Promise.all(
    [0, 1].map(() =>
      browser.newContext({ permissions: ["camera", "microphone"] }),
    ),
  );
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const [host, guest] = pages;
  try {
    for (const [index, participant] of pages.entries()) {
      await smallCamera(participant);
      await participant.addInitScript((delay) => {
        const probe: PlaybackProbe = {
          peers: [],
          pending: [],
          releaseAudio: !delay,
          blockAudio: delay,
          gesturePlays: 0,
        };
        (window as PlaybackWindow).__playback = probe;
        const Peer = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends Peer {
          constructor(config?: RTCConfiguration) {
            super(config);
            probe.peers.push(this);
            // Delay publication to the UI, not network transport. Audio RTP can
            // arrive before the audio track is supplied to the playback component.
            this.addEventListener("track", (event) => {
              if (event.track.kind !== "audio" || probe.releaseAudio) return;
              event.stopImmediatePropagation();
              probe.pending.push(() => this.ontrack?.call(this, event));
            });
          }
        };
        const play = HTMLAudioElement.prototype.play;
        HTMLAudioElement.prototype.play = function () {
          if (navigator.userActivation.isActive) probe.gesturePlays++;
          if (probe.blockAudio)
            return Promise.reject(
              new DOMException("Test autoplay policy", "NotAllowedError"),
            );
          return play.call(this);
        };
        navigator.mediaDevices.getDisplayMedia = async () => {
          const canvas = document.createElement("canvas");
          canvas.width = 1280;
          canvas.height = 720;
          const context = canvas.getContext("2d")!;
          const stream = canvas.captureStream(10);
          let frame = 0;
          const timer = setInterval(() => {
            if (stream.getVideoTracks()[0].readyState === "ended") {
              clearInterval(timer);
              return;
            }
            context.fillStyle = `hsl(${frame++ % 360} 60% 30%)`;
            context.fillRect(0, 0, canvas.width, canvas.height);
          }, 100);
          return stream;
        };
      }, index === 1);
    }
    await host.goto(FRONTEND);
    await host.evaluate(
      ({ code, token }) => localStorage.setItem(`zoom:host:${code}`, token),
      { code, token: created.host_token },
    );
    for (const [index, participant] of pages.entries()) {
      await participant.goto(`${FRONTEND}/meeting/${code}`);
      await participant
        .getByLabel("Your name", { exact: true })
        .fill(`Playback ${index}`);
      await participant
        .getByRole("button", {
          name: "Enable camera & microphone",
          exact: true,
        })
        .click();
      await participant
        .getByRole("button", {
          name: index ? "Join Meeting" : "Start Meeting",
          exact: true,
        })
        .click();
    }
    for (const participant of pages) {
      await expect
        .poll(async () => {
          const packets = await audioPackets(participant);
          return (
            packets.incoming > 0 && packets.outgoing > 0 && packets.frames > 0
          );
        })
        .toBe(true);
    }
    await expect(guest.locator(".remote-audio audio")).toHaveCount(1);
    await expect
      .poll(() =>
        guest
          .locator(".remote-audio audio")
          .evaluate((audio) => (audio as HTMLAudioElement).srcObject === null),
      )
      .toBe(true);
    await guest.evaluate(() => {
      const probe = (window as PlaybackWindow).__playback;
      probe.releaseAudio = true;
      probe.pending.splice(0).forEach((deliver) => deliver());
    });
    await expect(
      guest.getByRole("button", { name: "Enable Audio", exact: true }),
    ).toBeVisible();
    const before = await audioPackets(guest);
    await expect
      .poll(async () => (await audioPackets(guest)).incoming)
      .toBeGreaterThan(before.incoming);
    await guest.screenshot({ path: "../artifacts/audio-enable-chromium.png" });
    await guest.evaluate(() => {
      const probe = (window as PlaybackWindow).__playback;
      probe.blockAudio = false;
      probe.gesturePlays = 0;
      probe.element = document.querySelector<HTMLAudioElement>(
        ".remote-audio audio",
      )!;
      probe.element.volume = 0;
    });
    await guest
      .getByRole("button", { name: "Enable Audio", exact: true })
      .click();
    await expect(
      guest.getByRole("button", { name: "Enable Audio", exact: true }),
    ).toBeHidden();
    await expect
      .poll(() =>
        guest.evaluate(() => {
          const probe = (window as PlaybackWindow).__playback;
          const audio = probe.element!;
          const peer = probe.peers[0];
          return (
            probe.gesturePlays > 0 &&
            !audio.paused &&
            !audio.muted &&
            audio.volume === 1 &&
            (audio.srcObject as MediaStream)
              .getTracks()
              .every(
                (track) =>
                  track.kind === "audio" && track.readyState === "live",
              ) &&
            peer
              .getSenders()
              .some(
                (sender) =>
                  sender.track?.kind === "audio" && sender.track.enabled,
              ) &&
            peer
              .getReceivers()
              .some(
                (receiver) =>
                  receiver.track.kind === "audio" && !receiver.track.muted,
              )
          );
        }),
      )
      .toBe(true);
    await expect(guest.locator(".video-tile video")).toHaveCount(2);
    expect(
      await guest
        .locator(".video-tile video")
        .evaluateAll((elements) =>
          elements.every((video) => (video as HTMLVideoElement).muted),
        ),
    ).toBe(true);
    await host
      .getByRole("button", { name: "Share screen", exact: true })
      .click();
    await expect(guest.locator(".screen-tile video")).toBeVisible();
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
    ]) {
      await guest.setViewportSize(viewport);
      await expect
        .poll(() =>
          guest.evaluate(() => {
            const toolbar = document
              .querySelector(".meeting-toolbar")!
              .getBoundingClientRect();
            return Array.from(
              document.querySelectorAll(".video-tile"),
              (tile) => tile.getBoundingClientRect(),
            ).every((tile) => tile.bottom <= toolbar.top + 1);
          }),
        )
        .toBe(true);
      await guest.screenshot({
        path: `../artifacts/audio-sharing-${viewport.width}.png`,
      });
    }
    await expect
      .poll(() =>
        guest.evaluate(() => {
          const audio = document.querySelector<HTMLAudioElement>(
            ".remote-audio audio",
          )!;
          return (
            audio === (window as PlaybackWindow).__playback.element &&
            !audio.paused
          );
        }),
      )
      .toBe(true);
    await host.getByRole("button", { name: "Stop video", exact: true }).click();
    const sharing = await audioPackets(guest);
    await expect
      .poll(async () => (await audioPackets(guest)).incoming)
      .toBeGreaterThan(sharing.incoming);
    await host
      .getByRole("button", { name: "Stop sharing screen", exact: true })
      .click();
    await expect(guest.locator(".screen-tile")).toHaveCount(0);
    await guest.evaluate(() => {
      const probe = (window as PlaybackWindow).__playback;
      probe.blockAudio = true;
      probe.element!.pause();
    });
    await expect(
      guest.getByRole("button", { name: "Enable Audio", exact: true }),
    ).toBeVisible();
    await guest.evaluate(() => {
      (window as PlaybackWindow).__playback.blockAudio = false;
    });
    await guest
      .getByRole("button", { name: "Enable Audio", exact: true })
      .click();
    await expect
      .poll(() =>
        guest.evaluate(
          () => !(window as PlaybackWindow).__playback.element!.paused,
        ),
      )
      .toBe(true);
    await request.post(`${API}/api/meetings/${code}/end`, {
      headers: { Authorization: `Bearer ${created.host_token}` },
    });
    await expect(guest.locator(".meeting-room")).toHaveCount(0);
    expect(
      await guest.evaluate(() => {
        const probe = (window as PlaybackWindow).__playback;
        return (
          probe.element!.paused &&
          probe.element!.srcObject === null &&
          probe.peers.every(
            (peer) =>
              peer.connectionState === "closed" &&
              peer
                .getReceivers()
                .every((receiver) => receiver.track.readyState === "ended"),
          )
        );
      }),
    ).toBe(true);
  } finally {
    await request.post(`${API}/api/meetings/${code}/end`, {
      headers: { Authorization: `Bearer ${created.host_token}` },
    });
    await Promise.all(contexts.map((context) => context.close()));
  }
});
