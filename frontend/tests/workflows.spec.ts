import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";

const API = process.env.E2E_API_URL ?? "http://127.0.0.1:8000";
const screenshot = (name: string) => path.resolve("../artifacts", name);

test("scheduled meeting downloads a UTC calendar and reports export errors", async ({
  page,
  request,
}) => {
  const title = `Calendar export ${Date.now()}`;
  const created = await (
    await request.post(`${API}/api/meetings/schedule`, {
      data: {
        title,
        description: "Team review, priorities; next steps",
        scheduled_at: "2030-01-02T09:00:00+05:30",
        scheduled_timezone: "Asia/Kolkata",
        duration_minutes: 45,
      },
    })
  ).json();
  const code = created.meeting.meeting_code;
  await page.goto("/meetings");
  const meeting = page.locator(".manager-meeting").filter({ hasText: title });
  // Wait for hydrated, API-backed rows before using the controlled search input.
  await expect(meeting).toBeVisible();
  await page.getByRole("textbox", { name: "Search meetings" }).fill(title);
  await meeting.click();
  await expect(
    page
      .getByRole("region", { name: "Selected meeting details" })
      .getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Add to Calendar", exact: true })
    .click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(`meeting-${code}.ics`);
  const file = (await fs.readFile((await download.path())!, "utf8")).replace(
    /\r\n /g,
    "",
  );
  expect(file).toContain("DTSTART:20300102T033000Z\r\n");
  expect(file).toContain("DTEND:20300102T041500Z\r\n");
  expect(file).toContain(`URL:${created.meeting.invite_url}`);
  expect(file).toContain(`SUMMARY:${title}`);
  expect(
    await (await request.get(`${API}/api/meetings/${code}`)).json(),
  ).toEqual(created.meeting);
  await page.route(`${API}/api/meetings/${code}/calendar`, (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: "DATABASE_UNAVAILABLE",
          message: "Calendar server unavailable. Try again.",
        },
      },
    }),
  );
  await page
    .getByRole("button", { name: "Add to Calendar", exact: true })
    .click();
  await expect(page.locator(".toast-visible")).toContainText(
    "Calendar server unavailable",
  );
  await expect(
    page.getByRole("button", { name: "Add to Calendar", exact: true }),
  ).toBeEnabled();
  await expect(page).toHaveURL(/\/meetings$/);
});

test("workflow availability reflects database health and recovers", async ({
  page,
}) => {
  await page.route(`${API}/api/health`, (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: "DATABASE_UNAVAILABLE", message: "Unavailable" } },
    }),
  );
  for (const url of ["/join", "/schedule", "/meetings", "/"]) {
    await page.goto(url);
    await expect(page.locator(".connection-label")).toHaveText("Offline");
  }
  await page.unroute(`${API}/api/health`);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".connection-label")).toHaveText("Available");
});

test("Back and Forward release media and sockets before rejoining", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    const probe = window as unknown as Window & {
      __navigationStreams: MediaStream[];
      __navigationSockets: WebSocket[];
    };
    probe.__navigationStreams = [];
    probe.__navigationSockets = [];
    const getMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getMedia(constraints);
      probe.__navigationStreams.push(stream);
      return stream;
    };
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        probe.__navigationSockets.push(this);
      }
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "New Meeting", exact: true }).click();
  await expect(page).toHaveURL(/\/meeting\/\d{11}$/);
  const code = page.url().split("/").pop()!;
  await page
    .getByRole("button", { name: "Enable camera & microphone", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Mute microphone", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Start Meeting", exact: true })
    .click();
  await expect(page.locator(".room-connection")).toContainText("Connected");
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const probe = window as unknown as Window & {
          __navigationStreams: MediaStream[];
          __navigationSockets: WebSocket[];
        };
        return (
          probe.__navigationStreams.length >= 2 &&
          probe.__navigationStreams.every((stream) =>
            stream.getTracks().every((track) => track.readyState === "ended"),
          ) &&
          probe.__navigationSockets.every(
            (socket) => socket.readyState === WebSocket.CLOSED,
          )
        );
      }),
    )
    .toBe(true);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/meeting/${code}$`));
  await page.getByLabel("Your name", { exact: true }).fill("Alex Morgan");
  await page
    .getByRole("button", { name: "Start Meeting", exact: true })
    .click();
  await expect(page.locator(".room-connection")).toContainText("Connected");
  const token = await page.evaluate(
    (code) => localStorage.getItem(`zoom:host:${code}`),
    code,
  );
  await request.post(`${API}/api/meetings/${code}/end`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await expect(
    page.getByText("This meeting has ended.", { exact: true }),
  ).toBeVisible();
});

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
    .getByRole("link", { name: "Join", exact: true })
    .click();
  await page.getByLabel("Meeting ID or invitation link").fill("11111111111");
  await page.getByLabel("Your name", { exact: true }).fill("Test Guest");
  await page.getByRole("button", { name: "Join Meeting", exact: true }).click();
  await expect(page.locator(".join-page").getByRole("alert")).toContainText(
    "doesn't exist",
  );
  await page
    .getByLabel("Meeting ID or invitation link")
    .fill("https://unrelated.example/meeting/12345678901");
  await page.getByRole("button", { name: "Join Meeting", exact: true }).click();
  await expect(page.locator(".join-page").getByRole("alert")).toContainText(
    "invitation from this app",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("region", { name: "Meeting actions" })
    .getByRole("link", { name: "Schedule", exact: true })
    .click();
  const title = `E2E review ${Date.now()}`;
  const tomorrow = new Date(Date.now() + 86400000);
  const date = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
  await page.getByLabel(/Topic/).fill(title);
  await page.getByRole("button", { name: "Add Description" }).click();
  await page
    .getByLabel(/Description/)
    .fill("Persisted from the browser scheduling form.");
  await page.getByLabel("Date", { exact: true }).fill(date);
  await page.getByLabel("Time", { exact: true }).fill("14:30");
  await page.getByLabel("Duration").selectOption("45");
  await page.screenshot({ path: screenshot("schedule-page.png") });
  await page.getByRole("button", { name: "Save", exact: true }).click();
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
  await expect(page).toHaveURL(/\/meetings$/);
  await page.reload();
  await expect(
    page.locator(".manager-meeting").filter({ hasText: title }),
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

test("responsive pages support meeting selection without horizontal overflow", async ({
  page,
}) => {
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto("/");
    await expect(page.locator(".meeting-row").first()).toBeVisible();
    await page.screenshot({
      path: screenshot(`dashboard-${width}.png`),
      fullPage: true,
    });
    await page
      .getByRole("region", { name: "Meeting actions" })
      .getByRole("link", { name: "Join", exact: true })
      .click();
    await expect(page).toHaveURL(/\/join$/);
    await expect(
      page.getByRole("button", { name: "Join Meeting", exact: true }),
    ).toBeDisabled();
    await page.screenshot({
      path: screenshot(`join-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page
      .getByRole("region", { name: "Meeting actions" })
      .getByRole("link", { name: "Schedule", exact: true })
      .click();
    await expect(page).toHaveURL(/\/schedule$/);
    await expect(
      page.getByRole("button", { name: "Save", exact: true }),
    ).toBeDisabled();
    await page.screenshot({
      path: screenshot(`schedule-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page).toHaveURL(/\/meetings$/);
    await expect(page.locator(".manager-meeting").first()).toBeVisible();
    await page.screenshot({
      path: screenshot(`meetings-${width}.png`),
      fullPage: true,
    });
    const second = page.locator(".manager-meeting").nth(1);
    const title = await second.locator("strong").textContent();
    await second.click();
    await expect(second).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".manager-detail h2")).toHaveText(title!);
    await page.getByText("Show Meeting Invitation", { exact: true }).click();
    await expect(
      page.getByLabel("Invitation link", { exact: true }),
    ).toHaveValue(/\/meeting\/\d{11}$/);
    await page
      .getByRole("button", { name: "Copy Invitation", exact: true })
      .click();
    await expect(page.locator(".toast-visible")).toContainText("copied");
    if (width === 390) {
      await expect(page.locator(".manager-list")).not.toBeVisible();
      await page.screenshot({
        path: screenshot("meeting-detail-390.png"),
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Back to meetings", exact: true })
        .click();
      await expect(page.locator(".manager-list")).toBeVisible();
    } else {
      await expect(
        page.getByRole("button", { name: "Back to meetings", exact: true }),
      ).not.toBeVisible();
    }
    await page.getByRole("tab", { name: /Previous/ }).click();
    await expect(page.locator(".manager-detail-actions .primary")).toHaveCount(
      0,
    );
    if (width === 390) await page.locator(".manager-meeting").first().click();
    await expect(page.locator(".manager-detail .status-badge")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});

test("scheduling uses the browser timezone and keeps host access", async ({
  browser,
  request,
}) => {
  const context = await browser.newContext({ timezoneId: "America/New_York" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/schedule");
  await page.getByLabel(/Topic/).fill("Timezone regression meeting");
  const date = await page.evaluate(() => {
    const day = new Date();
    day.setDate(day.getDate() + 2);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  });
  await page.getByLabel("Date", { exact: true }).fill(date);
  await page.getByLabel("Time", { exact: true }).fill("14:30");
  await expect(page.locator(".schedule-timezone")).toContainText(
    /\(GMT-0[45]:00\) New York/,
  );
  const expected = await page.evaluate(
    (date) => new Date(`${date}T14:30:00`).toISOString(),
    date,
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const invitation = await page
    .getByLabel("Invitation link", { exact: true })
    .inputValue();
  const code = invitation.split("/").pop()!;
  const meeting = await (
    await request.get(`${API}/api/meetings/${code}`)
  ).json();
  expect(new Date(meeting.scheduled_at).toISOString()).toBe(expected);
  expect(meeting.scheduled_timezone).toBe("America/New_York");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page
    .locator(".manager-meeting")
    .filter({ hasText: "Timezone regression meeting" })
    .click();
  await expect(
    page
      .locator(".manager-detail")
      .getByRole("button", { name: "Start Meeting", exact: true }),
  ).toBeVisible();
  await page
    .locator(".manager-detail")
    .getByRole("button", { name: "Start Meeting", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Start Meeting", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await request.post(`${API}/api/meetings/${code}/end`, {
    headers: {
      Authorization: `Bearer ${await page.evaluate((code) => localStorage.getItem(`zoom:host:${code}`), code)}`,
    },
  });
  await context.close();
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

test("Start Meeting claims a sample safely and meeting tabs support keyboard navigation", async ({
  page,
  request,
}) => {
  const meetings = await (
    await request.get(`${API}/api/meetings/upcoming`)
  ).json();
  const sample = meetings.find(
    (meeting: { can_claim: boolean }) => meeting.can_claim,
  );
  expect(
    sample,
    "The idempotent seed should provide an unclaimed upcoming sample",
  ).toBeTruthy();
  await page.goto("/meetings");
  await page.getByRole("tab", { name: /Upcoming/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /Previous/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("ArrowLeft");
  await page
    .locator(".manager-meeting")
    .filter({ hasText: sample.title })
    .click();
  await page
    .locator(".manager-detail")
    .getByRole("button", { name: "Start Meeting", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/meeting/${sample.meeting_code}$`));
  const token = await page.evaluate(
    (code) => localStorage.getItem(`zoom:host:${code}`),
    sample.meeting_code,
  );
  expect(token).toBeTruthy();
  await expect(
    page.getByRole("button", { name: "Start Meeting", exact: true }),
  ).toBeVisible();
  expect(
    (
      await (
        await request.get(`${API}/api/meetings/${sample.meeting_code}`)
      ).json()
    ).can_claim,
  ).toBe(false);
  await request.post(`${API}/api/meetings/${sample.meeting_code}/end`, {
    headers: { Authorization: `Bearer ${token}` },
  });
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
  const toolbar = await host.locator(".meeting-toolbar").boundingBox();
  for (const button of await host.locator(".meeting-toolbar button").all()) {
    const bounds = await button.boundingBox();
    expect(
      bounds &&
        toolbar &&
        bounds.y >= toolbar.y &&
        bounds.y + bounds.height <= toolbar.y + toolbar.height,
    ).toBe(true);
  }
  await host
    .getByRole("button", { name: "More meeting controls", exact: true })
    .click();
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
  await host.getByRole("link", { name: "Zoom Workplace Home" }).click();
  await expect(host.getByRole("dialog")).toContainText("Leave this meeting?");
  await host.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(host.locator(".video-tile")).toHaveCount(2);
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
    .getByRole("link", { name: "Join", exact: true })
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
    if (navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException("Permission denied", "NotAllowedError");
      };
  });
  await page.goto(`/meeting/${created.meeting.meeting_code}`);
  const captureSupported = await page.evaluate(
    () => !!navigator.mediaDevices?.getUserMedia,
  );
  await page.getByLabel("Your name", { exact: true }).fill("Mobile Guest");
  await page
    .getByRole("button", { name: "Enable camera & microphone", exact: true })
    .click();
  await expect(
    page.getByText(
      captureSupported
        ? /Your camera is blocked/
        : /Camera access is unavailable/,
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      captureSupported
        ? /Your microphone is blocked/
        : /Microphone access is unavailable/,
    ),
  ).toBeVisible();
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
