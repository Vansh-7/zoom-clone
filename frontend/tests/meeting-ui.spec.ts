import { test, expect, type Page } from "@playwright/test";

const API = process.env.E2E_API_URL ?? "http://127.0.0.1:8000";
const FRONTEND = process.env.E2E_FRONTEND_URL ?? "http://localhost:3000";
test.use({ trace: "off" });

declare global {
  interface Window {
    __uiPeers: RTCPeerConnection[];
  }
}

async function mediaProbe(page: Page) {
  await page.addInitScript(() => {
    const Peer = RTCPeerConnection;
    window.__uiPeers = [];
    window.RTCPeerConnection = class extends Peer {
      constructor(config?: RTCConfiguration) {
        super(config);
        window.__uiPeers.push(this);
      }
    };
    const capture = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = (constraints) =>
      capture({
        ...constraints,
        video: constraints?.video
          ? { width: 640, height: 360, frameRate: 15 }
          : false,
      });
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext("2d")!;
      const stream = canvas.captureStream(10);
      let frame = 0;
      const timer = setInterval(() => {
        if (stream.getVideoTracks()[0].readyState === "ended") {
          clearInterval(timer);
          return;
        }
        ctx.fillStyle = `hsl(${frame++ % 360} 60% 25%)`;
        ctx.fillRect(0, 0, 1280, 720);
        ctx.fillStyle = "white";
        ctx.font = "36px sans-serif";
        ctx.fillText("Shared presentation", 40, 80);
      }, 100);
      return stream;
    };
  });
}

async function toolbarBounds(page: Page) {
  for (const button of await page
    .locator(".toolbar-control, .end-button, .room-header button")
    .all()) {
    await expect(button).toBeEnabled();
    const state = await button.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.x + box.width / 2,
        box.y + box.height / 2,
      );
      return {
        label: element.getAttribute("aria-label") ?? element.textContent,
        box: box.toJSON(),
        hit: hit?.className,
        accessible:
          box.left >= 0 &&
          box.right <= innerWidth &&
          box.top >= 0 &&
          box.bottom <= innerHeight &&
          !!hit &&
          element.contains(hit),
      };
    });
    expect(state.accessible, JSON.stringify(state)).toBe(true);
    await button.click({ trial: true });
  }
  expect(
    await page.evaluate(() => {
      const top = document
        .querySelector(".room-header")!
        .getBoundingClientRect().bottom;
      const bottom = document
        .querySelector(".meeting-toolbar")!
        .getBoundingClientRect().top;
      return (
        Array.from(document.querySelectorAll(".video-tile"), (tile) =>
          tile.getBoundingClientRect(),
        ).every((tile) => tile.top >= top - 1 && tile.bottom <= bottom + 1) &&
        document.documentElement.scrollWidth <= innerWidth
      );
    }),
  ).toBe(true);
}

async function cameraPlayback(page: Page) {
  await expect
    .poll(() =>
      page.locator(".camera-tile video").evaluateAll((elements) =>
        elements.every((element) => {
          const video = element as HTMLVideoElement;
          return (
            video.readyState >= 2 &&
            !video.paused &&
            video.videoWidth > 0 &&
            video.getVideoPlaybackQuality().totalVideoFrames > 0
          );
        }),
      ),
    )
    .toBe(true);
}

test("meeting popovers stay inside the room and above panels through resizing", async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  const created = await (
    await request.post(`${API}/api/meetings/instant`)
  ).json();
  const code = created.meeting.meeting_code;
  const assertPopover = async (label: string) => {
    const dialog = page.getByRole("dialog", { name: label, exact: true });
    await expect(dialog).toBeVisible();
    await expect
      .poll(() =>
        dialog.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const room = node.closest(".meeting-room")!.getBoundingClientRect();
          return (
            box.left >= room.left &&
            box.right <= room.right &&
            box.top >= room.top &&
            box.bottom <= room.bottom &&
            box.left >= 0 &&
            box.right <= innerWidth &&
            box.bottom <= innerHeight
          );
        }),
      )
      .toBe(true);
    for (const button of await dialog.getByRole("button").all()) {
      await button.scrollIntoViewIfNeeded();
      await button.click({ trial: true });
    }
  };
  try {
    await page.goto(FRONTEND);
    await page.evaluate(
      ({ code, token }) => localStorage.setItem(`zoom:host:${code}`, token),
      { code, token: created.host_token },
    );
    await page.goto(`${FRONTEND}/meeting/${code}`);
    await page.getByLabel("Your name", { exact: true }).fill("Alex Morgan");
    await page
      .getByRole("button", { name: "Start Meeting", exact: true })
      .click();
    await expect(page.locator(".room-connection")).toContainText("Connected");
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      await page
        .getByRole("button", { name: "Meeting information", exact: true })
        .click();
      await page.setViewportSize(viewport);
      await assertPopover("Meeting information");
      if (viewport.width === 1440)
        await page.screenshot({ path: "../artifacts/meeting-info-1440.png" });
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("button", { name: "Meeting information", exact: true }),
      ).toBeFocused();
      for (const panel of ["Show participants", "Show chat", "Host Tools"]) {
        const toggle = page.getByRole("button", { name: panel, exact: true });
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-pressed", "true");
        await page
          .getByRole("button", { name: "Meeting view", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Speaker View", exact: true })
          .click();
        await assertPopover("Meeting view");
        await page.keyboard.press("Escape");
        await page
          .getByRole("button", { name: "Reactions", exact: true })
          .click();
        await assertPopover("Meeting reactions");
        await page.keyboard.press("Escape");
        await expect(
          page.getByRole("button", { name: "Reactions", exact: true }),
        ).toBeFocused();
        await page
          .getByRole("button", { name: "More meeting controls", exact: true })
          .click();
        await assertPopover("More meeting controls");
        await page.keyboard.press("Escape");
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-pressed", "false");
      }
    }
  } finally {
    await request.post(`${API}/api/meetings/${code}/end`, {
      headers: { Authorization: `Bearer ${created.host_token}` },
    });
  }
});

test("four participants synchronize reactions, raised hands, speaker view and self view while sharing", async ({
  browser,
  request,
}) => {
  test.setTimeout(120000);
  const created = await (
    await request.post(`${API}/api/meetings/instant`)
  ).json();
  const code = created.meeting.meeting_code;
  const contexts = await Promise.all(
    Array.from({ length: 4 }, () =>
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
  const [host, guest, late, fourth] = pages;
  async function join(index: number) {
    const page = pages[index];
    await mediaProbe(page);
    await page.goto(`${FRONTEND}/meeting/${code}`);
    await page.getByLabel("Your name", { exact: true }).fill(`UI ${index}`);
    await page
      .getByRole("button", { name: "Enable camera & microphone", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: index ? "Join Meeting" : "Start Meeting",
        exact: true,
      })
      .click();
    await expect(page.locator(".media-connection")).toHaveAttribute(
      "data-state",
      index ? "connected" : "waiting",
    );
  }
  async function reaction(page: Page, name: string) {
    await page.getByRole("button", { name: "Reactions", exact: true }).click();
    await page.getByRole("button", { name, exact: true }).click();
  }
  try {
    await host.goto(FRONTEND);
    await host.evaluate(
      ({ code, token }) => localStorage.setItem(`zoom:host:${code}`, token),
      { code, token: created.host_token },
    );
    await join(0);
    await join(1);
    await reaction(host, "Clap");
    await reaction(guest, "Thumbs Up");
    for (const page of [host, guest])
      await expect(page.locator(".tile-reaction")).toHaveCount(2);
    await reaction(host, "Raise Hand");
    await expect(guest.locator(".tile-hand")).toHaveCount(1);
    await join(2);
    await expect(late.locator(".tile-hand")).toHaveCount(1);
    await expect(late.locator(".tile-reaction")).toHaveCount(0);
    for (const page of [host, guest])
      await expect(page.locator(".tile-reaction")).toHaveCount(0, {
        timeout: 5500,
      });
    await expect(host.locator(".tile-hand")).toHaveCount(1);
    await join(3);
    await reaction(late, "Laugh");
    await reaction(fourth, "Surprised");
    for (const page of pages)
      await expect(page.locator(".tile-reaction")).toHaveCount(2);
    for (const page of pages) {
      await expect(page.locator(".camera-tile")).toHaveCount(4);
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const live = window.__uiPeers.filter(
              (peer) => peer.connectionState === "connected",
            );
            const media = await Promise.all(
              live.map(async (peer) => {
                const stats = await peer.getStats();
                let audio = false,
                  video = false;
                stats.forEach((stat) => {
                  if (
                    stat.type === "inbound-rtp" &&
                    stat.kind === "audio" &&
                    stat.packetsReceived > 0
                  )
                    audio = true;
                  if (
                    stat.type === "inbound-rtp" &&
                    stat.kind === "video" &&
                    stat.framesDecoded > 0
                  )
                    video = true;
                });
                return audio && video;
              }),
            );
            return live.length === 3 && media.every(Boolean);
          }),
        )
        .toBe(true);
    }
    await host
      .getByRole("button", { name: "Meeting information", exact: true })
      .click();
    await expect(
      host.getByRole("dialog", { name: "Meeting information" }),
    ).toContainText(created.meeting.host_name);
    await expect(
      host.getByRole("dialog", { name: "Meeting information" }),
    ).toContainText(created.meeting.invite_url);
    await host
      .getByRole("button", { name: "Copy invitation URL", exact: true })
      .click();
    expect(await host.evaluate(() => navigator.clipboard.readText())).toBe(
      created.meeting.invite_url,
    );
    await host.keyboard.press("Escape");
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
    ]) {
      await host.setViewportSize(viewport);
      await toolbarBounds(host);
      await host
        .getByRole("button", { name: "Meeting view", exact: true })
        .click();
      await host
        .getByRole("button", { name: "Speaker View", exact: true })
        .click();
      await host
        .getByLabel("Spotlight participant", { exact: true })
        .selectOption({ label: "UI 1" });
      await host.keyboard.press("Escape");
      await expect(host.locator(".speaker-primary .tile-name")).toContainText(
        "UI 1",
      );
      await host
        .getByRole("button", { name: "Spotlight UI 2", exact: true })
        .focus();
      await host.keyboard.press("Enter");
      await expect(host.locator(".speaker-primary .tile-name")).toContainText(
        "UI 2",
      );
      await host
        .getByRole("button", { name: "Spotlight UI 1", exact: true })
        .click();
      await expect(host.locator(".camera-tile")).toHaveCount(4);
      await cameraPlayback(host);
      await toolbarBounds(host);
      await host.screenshot({
        path: `../artifacts/meeting-speaker-${viewport.width}.png`,
      });
      await host
        .getByRole("button", { name: "Meeting view", exact: true })
        .click();
      await host
        .getByRole("button", { name: "Hide Self View", exact: true })
        .click();
      await expect(host.locator(".local-tile.camera-tile")).toHaveCount(0);
      expect(
        await host.evaluate(() =>
          window.__uiPeers
            .filter((peer) => peer.connectionState === "connected")
            .every((peer) =>
              peer
                .getSenders()
                .some(
                  (sender) =>
                    sender.track?.kind === "video" && sender.track.enabled,
                ),
            ),
        ),
      ).toBe(true);
      await expect(
        guest.locator(".camera-tile").filter({ hasText: "UI 0" }),
      ).toHaveCount(1);
      await host
        .getByRole("button", { name: "Meeting view", exact: true })
        .click();
      await host
        .getByRole("button", { name: "Show Self View", exact: true })
        .click();
      await host
        .getByRole("button", { name: "Meeting view", exact: true })
        .click();
      await host
        .getByRole("button", { name: "Gallery View", exact: true })
        .click();
      await cameraPlayback(host);
      await host.screenshot({
        path: `../artifacts/meeting-gallery-${viewport.width}.png`,
      });
    }
    await host
      .getByRole("button", { name: "Share screen", exact: true })
      .click();
    for (const page of pages) {
      await expect(page.locator(".screen-tile")).toHaveCount(1);
      await expect(page.locator(".camera-tile")).toHaveCount(4);
      await cameraPlayback(page);
    }
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
    ]) {
      await host.setViewportSize(viewport);
      await toolbarBounds(host);
      await host
        .getByRole("button", { name: "Show participants", exact: true })
        .click();
      await expect(
        host
          .locator(".participant-row")
          .filter({ hasText: "UI 0" })
          .getByRole("img", { name: "UI 0 raised hand", exact: true }),
      ).toBeVisible();
      await toolbarBounds(host);
      await host.screenshot({
        path: `../artifacts/meeting-participants-${viewport.width}.png`,
      });
      await host
        .getByRole("button", { name: "Show chat", exact: true })
        .click();
      await toolbarBounds(host);
      await host.getByLabel("Message everyone").fill("Sharing with the team");
      await host.getByRole("button", { name: "Send", exact: true }).click();
      await expect(
        guest.getByRole("button", { name: "Show chat", exact: true }),
      ).toBeVisible();
      await host.screenshot({
        path: `../artifacts/meeting-chat-${viewport.width}.png`,
      });
      await host
        .getByRole("button", { name: "Close chat", exact: true })
        .click();
      if (viewport.width === 1440) {
        await host
          .getByRole("button", { name: "Meeting view", exact: true })
          .click();
        await host
          .getByRole("button", { name: "Fullscreen", exact: true })
          .click();
        await expect
          .poll(() => host.evaluate(() => !!document.fullscreenElement))
          .toBe(true);
        await toolbarBounds(host);
        await host
          .getByRole("button", { name: "Toggle full screen", exact: true })
          .click();
        await expect
          .poll(() => host.evaluate(() => !!document.fullscreenElement))
          .toBe(false);
      }
    }
    await host.getByRole("button", { name: "Reactions", exact: true }).click();
    await host.screenshot({ path: "../artifacts/meeting-reactions-390.png" });
    await host.getByRole("button", { name: "Lower Hand", exact: true }).click();
    for (const page of pages)
      await expect(page.locator(".tile-hand")).toHaveCount(0);
    await host
      .getByRole("button", { name: "Stop sharing screen", exact: true })
      .click();
    await expect(host.locator(".screen-tile")).toHaveCount(0);
    await host.getByRole("button", { name: "Host Tools", exact: true }).click();
    await expect(
      host.getByRole("complementary", { name: "Host tools" }),
    ).toBeVisible();
    await host.screenshot({ path: "../artifacts/meeting-host-tools-390.png" });
    await host
      .getByRole("button", { name: "Close host tools", exact: true })
      .click();
    await host.getByRole("button", { name: "Host Tools", exact: true }).click();
    const hostPanel = host.getByRole("complementary", {
      name: "Host tools",
      exact: true,
    });
    await hostPanel
      .getByRole("button", { name: "Mute All", exact: true })
      .click();
    for (const page of [guest, late, fourth]) {
      await expect(
        page.getByRole("button", { name: "Unmute microphone", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(() =>
          window.__uiPeers
            .filter((peer) => peer.connectionState === "connected")
            .every((peer) =>
              peer
                .getSenders()
                .filter((sender) => sender.track?.kind === "audio")
                .every((sender) => !sender.track!.enabled),
            ),
        ),
      ).toBe(true);
    }
    await hostPanel
      .getByRole("button", { name: "Remove UI 3", exact: true })
      .click();
    await host
      .getByRole("button", { name: "Remove Participant", exact: true })
      .click();
    await expect(fourth.locator(".meeting-room")).toHaveCount(0);
    await expect(host.locator(".camera-tile")).toHaveCount(3);
    await hostPanel
      .getByRole("button", { name: "End Meeting for Everyone", exact: true })
      .click();
    await host
      .getByRole("button", { name: "End Meeting for All", exact: true })
      .click();
    for (const page of [guest, late, fourth])
      await expect(page.locator(".meeting-room")).toHaveCount(0);
  } catch (error) {
    await host.screenshot({ path: "../artifacts/meeting-ui-failure.png" });
    throw error;
  } finally {
    await request.post(`${API}/api/meetings/${code}/end`, {
      headers: { Authorization: `Bearer ${created.host_token}` },
    });
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("original favicon is linked and served without changing page metadata", async ({
  page,
  request,
}) => {
  await page.goto(FRONTEND);
  await expect(page).toHaveTitle("Zoom Workplace | Meetings");
  const icon = page.locator('link[rel="icon"][type="image/svg+xml"]');
  await expect(icon).toHaveCount(1);
  const path = await icon.getAttribute("href");
  const response = await request.get(new URL(path!, FRONTEND).href);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/svg+xml");
  expect(await response.text()).toContain('fill="#0b6ff4"');
  for (const selector of [
    'link[rel="icon"][type="image/png"]',
    'link[rel="apple-touch-icon"]',
  ]) {
    const link = page.locator(selector);
    await expect(link).toHaveCount(1);
    const asset = await request.get(
      new URL((await link.getAttribute("href"))!, FRONTEND).href,
    );
    expect(asset.status()).toBe(200);
    expect(asset.headers()["content-type"]).toContain("image/png");
    expect((await asset.body()).subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  }
});

test("chat preserves reading position and follows new messages on request", async ({
  browser,
  request,
}) => {
  const created = await (
    await request.post(`${API}/api/meetings/instant`)
  ).json();
  const code = created.meeting.meeting_code;
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
  ]);
  const [host, guest] = await Promise.all(
    contexts.map((context) => context.newPage()),
  );
  try {
    await host.goto(FRONTEND);
    await host.evaluate(
      ({ code, token }) => localStorage.setItem(`zoom:host:${code}`, token),
      { code, token: created.host_token },
    );
    for (const [index, page] of [host, guest].entries()) {
      await page.goto(`${FRONTEND}/meeting/${code}`);
      await page.getByLabel("Your name", { exact: true }).fill(`Chat ${index}`);
      await page
        .getByRole("button", {
          name: index ? "Join Meeting" : "Start Meeting",
          exact: true,
        })
        .click();
      await expect(page.locator(".room-connection").first()).toContainText(
        "Connected",
      );
      await page
        .getByRole("button", { name: "Show chat", exact: true })
        .click();
    }
    const send = async (page: Page, text: string) => {
      await page.getByLabel("Message everyone").fill(text);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(host.locator(".chat-message").last()).toContainText(text);
      await expect(guest.locator(".chat-message").last()).toContainText(text);
      await page.waitForTimeout(550);
    };
    for (let index = 0; index < 8; index++)
      await send(
        guest,
        `Message ${index}: ${"Reading earlier messages. ".repeat(10)}`,
      );
    const log = host.getByRole("log", { name: "Messages" });
    expect(
      await log.evaluate((node) => node.scrollHeight > node.clientHeight),
    ).toBe(true);
    await log.evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect.poll(() => log.evaluate((node) => node.scrollTop)).toBe(0);
    await send(guest, "A new message while reading history");
    await expect(
      host.getByRole("button", { name: "New messages", exact: true }),
    ).toBeVisible();
    expect(await log.evaluate((node) => node.scrollTop)).toBeLessThan(2);
    await host
      .getByRole("button", { name: "New messages", exact: true })
      .click();
    await expect
      .poll(() =>
        log.evaluate(
          (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
        ),
      )
      .toBeLessThan(2);
    await send(guest, "Follow the next message automatically");
    await expect
      .poll(() =>
        log.evaluate(
          (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
        ),
      )
      .toBeLessThan(2);
    await log.evaluate((node) => {
      node.scrollTop = 0;
    });
    await send(host, "My reply returns to the latest message");
    await expect
      .poll(() =>
        log.evaluate(
          (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
        ),
      )
      .toBeLessThan(2);
  } finally {
    await request.post(`${API}/api/meetings/${code}/end`, {
      headers: { Authorization: `Bearer ${created.host_token}` },
    });
    await Promise.all(contexts.map((context) => context.close()));
  }
});
