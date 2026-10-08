import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const API = process.env.E2E_API_URL ?? "http://127.0.0.1:8000";
const screenshot = (name: string) => path.resolve("../artifacts", name);

test("dashboard, join validation, scheduling, and persistence", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Upcoming meetings/ }),
  ).toBeVisible();
  await expect(page.locator(".meeting-row").first()).toBeVisible();
  await page.screenshot({
    path: screenshot("dashboard-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("region", { name: "Meeting actions" })
    .getByRole("button", { name: "Join", exact: true })
    .click();
  await page.getByLabel("Meeting ID or invitation link").fill("11111111111");
  await page.getByLabel("Your name", { exact: true }).fill("Test Guest");
  await page.getByRole("button", { name: "Join Meeting", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "doesn't exist",
  );
  await page
    .getByLabel("Meeting ID or invitation link")
    .fill("https://unrelated.example/meeting/12345678901");
  await page.getByRole("button", { name: "Join Meeting", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "invitation from this app",
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("region", { name: "Meeting actions" })
    .getByRole("button", { name: "Schedule", exact: true })
    .click();
  const title = `E2E review ${Date.now()}`;
  const tomorrow = new Date(Date.now() + 86400000);
  const date = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
  await page.getByLabel(/Topic/).fill(title);
  await page
    .getByLabel(/Description/)
    .fill("Persisted from the browser scheduling form.");
  await page.getByLabel("Date", { exact: true }).fill(date);
  await page.getByLabel("Time", { exact: true }).fill("14:30");
  await page.getByLabel("Duration").selectOption("45");
  await page.screenshot({ path: screenshot("schedule-dialog.png") });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Schedule", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your meeting is scheduled" }),
  ).toBeVisible();
  const invitation = await page
    .getByLabel("Invitation link", { exact: true })
    .inputValue();
  await page
    .getByRole("button", { name: "Copy Invitation", exact: true })
    .click();
  await expect(page.getByRole("status").last()).toContainText("copied");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: title, exact: true }),
  ).toBeVisible();
  const code = invitation.split("/").pop();
  const record = await request.get(`${API}/api/meetings/${code}`);
  expect(record.status()).toBe(200);
  expect((await record.json()).duration_minutes).toBe(45);
  await test.info().attach("scheduled-meeting", {
    body: JSON.stringify(await record.json(), null, 2),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
});

test("responsive dashboard and dialogs have no horizontal overflow", async ({
  page,
}) => {
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto("/");
    await expect(page.locator(".meeting-row").first()).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: screenshot(`dashboard-${width}.png`),
      fullPage: true,
    });
    await page
      .getByRole("region", { name: "Meeting actions" })
      .getByRole("button", { name: "Join", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.screenshot({ path: screenshot(`join-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
  }
});

test("backend unavailable and empty states stay usable", async ({ page }) => {
  await page.route(`${API}/api/**`, (route) => route.abort());
  await page.goto("/");
  await expect(page.locator(".error-notice")).toContainText(
    "couldn't reach the meeting server",
  );
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".connection-label")).toHaveText("Offline");
  await expect(page.locator(".hero-caption")).toHaveText(
    "Waiting for the meeting server.",
  );
  await page.unroute(`${API}/api/**`);
  await page.route(`${API}/api/meetings/upcoming`, (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route(`${API}/api/meetings/recent`, (route) =>
    route.fulfill({ json: [] }),
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "No upcoming meetings" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No recent meetings" }),
  ).toBeVisible();
});

test("guest waits until the creating browser starts the meeting", async ({
  browser,
  request,
}) => {
  const created = await (
    await request.post(`${API}/api/meetings/schedule`, {
      data: {
        title: "E2E host-first meeting",
        scheduled_at: new Date(Date.now() + 3600000).toISOString(),
        duration_minutes: 30,
        scheduled_timezone: "UTC",
      },
    })
  ).json();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/meeting/${created.meeting.meeting_code}`);
  await page.getByLabel("Your name", { exact: true }).fill("Waiting Guest");
  await page.getByRole("button", { name: "Join Meeting", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Waiting for the host" }),
  ).toBeVisible();
  await request.post(
    `${API}/api/meetings/${created.meeting.meeting_code}/start`,
    { headers: { Authorization: `Bearer ${created.host_token}` } },
  );
  await expect(
    page.getByRole("status").filter({ hasText: "Waiting for the host" }),
  ).not.toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "Join Meeting", exact: true }).click();
  await expect(page.locator(".meeting-room")).toBeVisible();
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  await request.post(
    `${API}/api/meetings/${created.meeting.meeting_code}/end`,
    { headers: { Authorization: `Bearer ${created.host_token}` } },
  );
  await context.close();
});

async function capturePeers(page: Page, duplicateJoin = false) {
  await page.addInitScript((duplicateJoin) => {
    const Original = window.RTCPeerConnection;
    const peers: RTCPeerConnection[] = [];
    Object.defineProperty(window, "__testPeers", { value: peers });
    window.RTCPeerConnection = class extends Original {
      offerCount = 0;
      constructor(config?: RTCConfiguration) {
        super(config);
        peers.push(this);
        const originalOffer = this.createOffer.bind(this);
        this.createOffer = (async (options?: RTCOfferOptions) => {
          this.offerCount++;
          if (duplicateJoin)
            await new Promise((resolve) => setTimeout(resolve, 100));
          return originalOffer(options);
        }) as RTCPeerConnection["createOffer"];
      }
    };
    if (duplicateJoin) {
      const OriginalSocket = window.WebSocket;
      window.WebSocket = class extends OriginalSocket {
        pendingOffer: string | null = null;
        sawCandidate = false;
        send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
          if (this.url.includes("/ws/meetings/") && typeof data === "string") {
            const message = JSON.parse(data);
            if (message.type === "offer" && !this.sawCandidate) {
              this.pendingOffer = data;
              // Exercise ICE arriving before its description, not just the usual order.
              setTimeout(() => {
                if (this.pendingOffer && this.readyState === WebSocket.OPEN) {
                  super.send(this.pendingOffer);
                  this.pendingOffer = null;
                }
              }, 500);
              return;
            }
            if (message.type === "candidate") {
              this.sawCandidate = true;
              if (this.pendingOffer) {
                super.send(data);
                super.send(this.pendingOffer);
                this.pendingOffer = null;
                return;
              }
            }
          }
          super.send(data);
        }
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          let duplicated = false;
          this.addEventListener("message", (event) => {
            if (
              !duplicated &&
              typeof event.data === "string" &&
              this.url.includes("/ws/meetings/") &&
              JSON.parse(event.data).type === "participant-joined"
            ) {
              duplicated = true;
              queueMicrotask(() =>
                this.dispatchEvent(
                  new MessageEvent("message", { data: event.data }),
                ),
              );
            }
          });
        }
      };
    }
  }, duplicateJoin);
}

async function inboundPackets(page: Page, kind: string) {
  return page.evaluate(async (kind) => {
    const peers = (window as Window & { __testPeers?: RTCPeerConnection[] })
      .__testPeers;
    let packets = 0;
    for (const peer of peers ?? []) {
      const stats = await peer.getStats();
      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === kind)
          packets += report.packetsReceived ?? 0;
      });
    }
    return packets;
  }, kind);
}

test("two-person audio/video, mute, leave, removal, and end for all", async ({
  browser,
  request,
}) => {
  const permissions = [
    "camera",
    "microphone",
    "clipboard-read",
    "clipboard-write",
  ];
  const hostContext = await browser.newContext({
    permissions,
    viewport: { width: 1440, height: 900 },
  });
  const guestContext = await browser.newContext({
    permissions,
    viewport: { width: 1440, height: 900 },
  });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const errors: string[] = [];
  host.on("pageerror", (error) => errors.push(error.message));
  guest.on("pageerror", (error) => errors.push(error.message));
  await capturePeers(host, true);
  await capturePeers(guest);
  await host.goto("/");
  await host.getByRole("button", { name: "New Meeting", exact: true }).click();
  await expect(host).toHaveURL(/\/meeting\/\d{11}/);
  const invite = host.url();
  const code = invite.split("/").pop();
  await expect(host.getByLabel("Your name", { exact: true })).toHaveValue(
    "Alex Morgan",
  );
  await host
    .getByRole("button", { name: "Enable camera & microphone", exact: true })
    .click();
  await expect(
    host.getByRole("button", { name: "Mute microphone", exact: true }),
  ).toBeEnabled();
  await host.screenshot({ path: screenshot("meeting-preview.png") });
  await host
    .getByRole("button", { name: "Start Meeting", exact: true })
    .click();
  await expect(host.locator(".room-connection")).toContainText("Connected");
  await host.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(host.getByRole("status").last()).toContainText("copied");
  await expect
    .poll(async () => {
      const toast = await host.locator(".toast-visible").boundingBox();
      const toolbar = await host.locator(".meeting-toolbar").boundingBox();
      return !!toast && !!toolbar && toast.y + toast.height <= toolbar.y;
    })
    .toBe(true);
  await guest.goto(invite);
  await guest.getByLabel("Your name", { exact: true }).fill("Jordan Lee");
  await guest
    .getByRole("button", { name: "Enable camera & microphone", exact: true })
    .click();
  await expect(
    guest.getByRole("button", { name: "Mute microphone", exact: true }),
  ).toBeEnabled();
  await guest
    .getByRole("button", { name: "Join Meeting", exact: true })
    .click();
  await expect(guest.locator(".room-connection")).toContainText("Connected");
  await expect(host.locator(".video-tile")).toHaveCount(2);
  await expect(guest.locator(".video-tile")).toHaveCount(2);
  await expect
    .poll(() =>
      host.evaluate(() => {
        const peers = (
          window as Window & { __testPeers?: { offerCount: number }[] }
        ).__testPeers;
        return peers?.[0]?.offerCount;
      }),
    )
    .toBe(1);
  for (const page of [host, guest]) {
    await expect
      .poll(() => inboundPackets(page, "video"), { timeout: 20000 })
      .toBeGreaterThan(0);
    await expect
      .poll(() => inboundPackets(page, "audio"), { timeout: 20000 })
      .toBeGreaterThan(0);
  }
  await expect
    .poll(() =>
      host
        .locator('video[aria-label="Jordan Lee video"]')
        .evaluate((video: HTMLVideoElement) => video.videoWidth),
    )
    .toBeGreaterThan(0);
  await host.screenshot({
    path: screenshot("meeting-two-person.png"),
    fullPage: true,
  });
  const mediaEvidence = {
    host: {
      audio: await inboundPackets(host, "audio"),
      video: await inboundPackets(host, "video"),
    },
    guest: {
      audio: await inboundPackets(guest, "audio"),
      video: await inboundPackets(guest, "video"),
    },
  };
  await test.info().attach("real-webrtc-inbound-packets", {
    body: JSON.stringify(mediaEvidence, null, 2),
    contentType: "application/json",
  });
  await host
    .getByRole("button", { name: "Show participants", exact: true })
    .click();
  await host.getByRole("button", { name: "Mute All", exact: true }).click();
  await expect(
    guest.getByRole("button", { name: "Unmute microphone", exact: true }),
  ).toBeVisible();
  await guest
    .getByRole("button", { name: "Unmute microphone", exact: true })
    .click();
  await expect(
    guest.getByRole("button", { name: "Mute microphone", exact: true }),
  ).toBeVisible();
  await guest.getByRole("button", { name: "Stop video", exact: true }).click();
  await expect(
    host
      .locator(".video-tile")
      .filter({ hasText: "Jordan Lee" })
      .locator(".tile-placeholder"),
  ).toBeVisible();
  await guest.getByRole("button", { name: "Start video", exact: true }).click();
  await guest.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(host.locator(".video-tile")).toHaveCount(1);
  await expect(guest).toHaveURL(new URL("/", invite).href);
  await guest
    .getByRole("region", { name: "Meeting actions" })
    .getByRole("button", { name: "Join", exact: true })
    .click();
  await guest.getByLabel("Meeting ID or invitation link").fill(code!);
  await guest.getByLabel("Your name", { exact: true }).fill("Jordan Lee");
  await guest
    .getByRole("button", { name: "Join Meeting", exact: true })
    .click();
  await expect(guest).toHaveURL(invite);
  await guest
    .getByRole("button", { name: "Join Meeting", exact: true })
    .click();
  await expect(host.locator(".video-tile")).toHaveCount(2);
  await guest.getByRole("button", { name: "Start video", exact: true }).click();
  await guest
    .getByRole("button", { name: "Unmute microphone", exact: true })
    .click();
  await expect
    .poll(() =>
      host
        .locator('video[aria-label="Jordan Lee video"]')
        .evaluate((video: HTMLVideoElement) => video.videoWidth),
    )
    .toBeGreaterThan(0);
  await host
    .getByRole("button", { name: "Remove Jordan Lee", exact: true })
    .click();
  await host
    .getByRole("button", { name: "Remove Participant", exact: true })
    .click();
  await expect(
    guest.getByRole("heading", {
      name: "The host removed you from this meeting.",
    }),
  ).toBeVisible();
  await expect(host.locator(".video-tile")).toHaveCount(1);
  await host.getByRole("button", { name: "End", exact: true }).click();
  await host
    .getByRole("button", { name: "End Meeting for All", exact: true })
    .click();
  await expect(host).toHaveURL(new URL("/", invite).href);
  expect(
    (await (await request.get(`${API}/api/meetings/${code}`)).json()).status,
  ).toBe("ended");
  expect(errors).toEqual([]);
  await hostContext.close();
  await guestContext.close();
});

test("permission denial still allows a mobile guest to join without media", async ({
  browser,
  request,
}) => {
  const created = await (
    await request.post(`${API}/api/meetings/instant`)
  ).json();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    };
  });
  await page.goto(`/meeting/${created.meeting.meeting_code}`);
  await page.getByLabel("Your name", { exact: true }).fill("Mobile Guest");
  await page
    .getByRole("button", { name: "Enable camera & microphone", exact: true })
    .click();
  await expect(page.getByText(/Your camera is blocked/)).toBeVisible();
  await expect(page.getByText(/Your microphone is blocked/)).toBeVisible();
  await page.screenshot({
    path: screenshot("mobile-prejoin-permission.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Join Meeting", exact: true }).click();
  await expect(page.locator(".room-connection")).toContainText("Connected");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Show participants", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Participants (1)" }),
  ).toBeVisible();
  await page.screenshot({
    path: screenshot("meeting-mobile.png"),
    fullPage: true,
  });
  await request.post(
    `${API}/api/meetings/${created.meeting.meeting_code}/end`,
    { headers: { Authorization: `Bearer ${created.host_token}` } },
  );
  await expect(
    page.getByRole("heading", { name: "This meeting has ended." }),
  ).toBeVisible();
  await context.close();
});
