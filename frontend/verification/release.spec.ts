import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const API = process.env.E2E_API_URL!;
const FRONTEND = process.env.E2E_FRONTEND_URL!;
const evidence = path.resolve("../artifacts/release");

interface Probe {
  peers: RTCPeerConnection[];
  streams: MediaStream[];
  sockets: WebSocket[];
  messages: { type: string; code?: string }[];
  blocked: boolean;
}

async function probe(page: Page, blocked = false) {
  await page.addInitScript((blocked) => {
    const state: Probe = {
      peers: [],
      streams: [],
      sockets: [],
      messages: [],
      blocked,
    };
    Object.defineProperty(window, "__release", { value: state });
    const capture = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await capture(constraints);
      state.streams.push(stream);
      return stream;
    };
    const Peer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer {
      constructor(config?: RTCConfiguration) {
        super(config);
        state.peers.push(this);
      }
    };
    const Socket = window.WebSocket;
    window.WebSocket = class extends Socket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        state.sockets.push(this);
        this.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);
          state.messages.push({ type: message.type, code: message.code });
        });
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (state.blocked && typeof data === "string") {
          const message = JSON.parse(data);
          if (message.type === "candidate" && message.payload.candidate)
            message.payload.candidate = message.payload.candidate.replace(
              /^(candidate:\S+ \d+ \S+ \d+) \S+ \d+/,
              "$1 203.0.113.1 50000",
            );
          if (message.payload?.sdp)
            message.payload.sdp = message.payload.sdp.replace(
              /^(a=candidate:\S+ \d+ \S+ \d+) \S+ \d+/gm,
              "$1 203.0.113.1 50000",
            );
          data = JSON.stringify(message);
        }
        super.send(data);
      }
    };
  }, blocked);
}

async function stats(page: Page) {
  return page.evaluate(async () => {
    const probe = (window as unknown as { __release: Probe }).__release;
    const result = {
      audioIn: 0,
      videoIn: 0,
      audioOut: 0,
      videoOut: 0,
      frames: 0,
      pairs: [] as string[],
    };
    for (const peer of probe.peers.filter(
      (pc) => pc.connectionState !== "closed",
    )) {
      const reports = await peer.getStats();
      reports.forEach((report) => {
        if (report.type === "inbound-rtp") {
          if (report.kind === "audio")
            result.audioIn += report.packetsReceived ?? 0;
          if (report.kind === "video") {
            result.videoIn += report.packetsReceived ?? 0;
            result.frames += report.framesDecoded ?? 0;
          }
        }
        if (report.type === "outbound-rtp") {
          if (report.kind === "audio")
            result.audioOut += report.packetsSent ?? 0;
          if (report.kind === "video")
            result.videoOut += report.packetsSent ?? 0;
        }
        if (report.type === "transport" && report.selectedCandidatePairId) {
          const pair = reports.get(report.selectedCandidatePairId);
          const local = reports.get(pair.localCandidateId);
          const remote = reports.get(pair.remoteCandidateId);
          result.pairs.push(
            `${local?.candidateType}/${remote?.candidateType}/${local?.protocol}`,
          );
        }
      });
    }
    return result;
  });
}

async function media(page: Page) {
  const before = await stats(page);
  await expect
    .poll(
      async () => {
        const after = await stats(page);
        return ["audioIn", "videoIn", "audioOut", "videoOut", "frames"].every(
          (key) =>
            after[key as keyof typeof before] >
            before[key as keyof typeof before],
        );
      },
      { timeout: 30000 },
    )
    .toBe(true);
  await expect(page.locator(".media-connection")).toHaveAttribute(
    "data-state",
    "connected",
  );
  await expect
    .poll(() =>
      page.locator(".video-tile video").evaluateAll((elements) =>
        elements
          .filter((element) => !(element as HTMLVideoElement).muted)
          .some((element) => {
            const video = element as HTMLVideoElement;
            return video.videoWidth > 0 && !video.paused;
          }),
      ),
    )
    .toBe(true);
}

async function clean(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const probe = (window as unknown as { __release: Probe }).__release;
        return (
          probe.streams.every((stream) =>
            stream.getTracks().every((track) => track.readyState === "ended"),
          ) &&
          probe.peers.every((pc) => pc.connectionState === "closed") &&
          probe.sockets.every(
            (socket) => socket.readyState === WebSocket.CLOSED,
          )
        );
      }),
    )
    .toBe(true);
}

async function enter(page: Page, invite: string, name: string, host = false) {
  await page.goto(invite);
  await page.getByLabel("Your name", { exact: true }).fill(name);
  await page
    .getByRole("button", { name: "Enable camera & microphone", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Mute microphone", exact: true }),
  ).toBeEnabled();
  for (const name of ["Camera", "Microphone"])
    await expect(
      page.getByRole("combobox", { name, exact: true }),
    ).toBeEnabled();
  const microphone = page.getByRole("combobox", {
    name: "Microphone",
    exact: true,
  });
  const inputs = await microphone
    .locator("option")
    .evaluateAll((options) =>
      options
        .map((option) => (option as HTMLOptionElement).value)
        .filter(Boolean),
    );
  if (inputs.length > 1) {
    await microphone.selectOption(inputs[1]);
    await expect(microphone).toBeEnabled();
    await expect(microphone).toHaveValue(inputs[1]);
  }
  await page
    .getByRole("button", {
      name: host ? "Start Meeting" : "Join Meeting",
      exact: true,
    })
    .click();
  await expect(page.locator(".room-connection")).toContainText(
    "Signaling: Connected",
  );
}

test("public workflows, calendar export, responsive navigation and persistence snapshot", async ({
  page,
  request,
}) => {
  await fs.mkdir(evidence, { recursive: true });
  await page.goto("/");
  await expect(page.locator(".connection-label")).toHaveText("Available");
  await page.goto("/join");
  await expect(
    page.getByRole("button", { name: "Join Meeting", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Meeting ID or invitation link").fill("11111111111");
  await page.getByLabel("Your name", { exact: true }).fill("Release guest");
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
  const title = `Release verification ${Date.now()}`;
  await page.goto("/schedule");
  await page.getByLabel(/Topic/).fill(title);
  await page.getByRole("button", { name: "Add Description" }).click();
  await page
    .getByLabel(/Description/)
    .fill("Non-destructive release persistence check.");
  const date = await page.evaluate(() => {
    const future = new Date(Date.now() + 2 * 86400000);
    return `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}`;
  });
  await page.getByLabel("Date", { exact: true }).fill(date);
  await page.getByLabel("Time", { exact: true }).fill("14:30");
  await page.getByLabel("Duration").selectOption("45");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your meeting is scheduled" }),
  ).toBeVisible();
  const invite = await page
    .getByLabel("Invitation link", { exact: true })
    .inputValue();
  expect(new URL(invite).origin).toBe(new URL(FRONTEND).origin);
  const code = invite.split("/").pop()!;
  await page
    .getByRole("button", { name: "Copy Invitation", exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    invite,
  );
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page).toHaveURL(/\/meetings$/);
  await page.reload();
  await page.getByRole("textbox", { name: "Search meetings" }).fill(title);
  await page.locator(".manager-meeting").filter({ hasText: title }).click();
  const downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Add to Calendar", exact: true })
    .click();
  const download = await downloadEvent;
  const calendar = (
    await fs.readFile((await download.path())!, "utf8")
  ).replace(/\r\n /g, "");
  const record = await (
    await request.get(`${API}/api/meetings/${code}`)
  ).json();
  const stamp = (date: Date) =>
    date
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
  expect(calendar).toContain(
    `DTSTART:${stamp(new Date(record.scheduled_at))}\r\n`,
  );
  expect(calendar).toContain(
    `DTEND:${stamp(new Date(Date.parse(record.scheduled_at) + 45 * 60000))}\r\n`,
  );
  expect(calendar).toContain(`URL:${invite}`);
  expect(record.title).toBe(title);
  expect(record.status).toBe("scheduled");
  await fs.writeFile(
    path.join(evidence, "persistence-before.json"),
    JSON.stringify(record, null, 2),
  );
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    for (const url of ["/", "/meetings", "/schedule", "/join"]) {
      await page.goto(url);
      await expect(page.locator(".connection-label")).toHaveText("Available");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: path.join(evidence, `${url.slice(1) || "home"}-${width}.png`),
        fullPage: true,
      });
    }
    await page.goto("/meetings");
    await page.getByRole("textbox", { name: "Search meetings" }).fill(title);
    const row = page.locator(".manager-meeting").filter({ hasText: title });
    await row.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".manager-detail h2")).toHaveText(title);
    if (width === 390) {
      await expect(page.locator(".manager-list")).not.toBeVisible();
      await page
        .getByRole("button", { name: "Back to meetings", exact: true })
        .click();
      await expect(page.locator(".manager-list")).toBeVisible();
    }
    await page.getByRole("tab", { name: /Upcoming/ }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: /Previous/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  }
  await page.goto("/join");
  await page.route(`${API}/api/**`, (route) => route.abort());
  await page.goto("/");
  await expect(page.locator(".connection-label")).toHaveText("Offline");
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  await page.unroute(`${API}/api/**`);
  await page.reload();
  await expect(page.locator(".connection-label")).toHaveText("Available");
});

test("deployed ICE configuration, real two-party RTP, sharing, chat and host controls", async ({
  browser,
  request,
}) => {
  await fs.mkdir(evidence, { recursive: true });
  const contexts = await Promise.all(
    [0, 1].map(() =>
      browser.newContext({
        permissions: [
          "camera",
          "microphone",
          "clipboard-read",
          "clipboard-write",
        ],
        viewport: { width: 1440, height: 900 },
      }),
    ),
  );
  const [host, guest] = await Promise.all(
    contexts.map((context) => context.newPage()),
  );
  const errors: string[] = [];
  for (const page of [host, guest]) {
    page.on("pageerror", (error) => errors.push(error.message));
    await probe(page);
  }
  let code = "",
    token = "";
  try {
    await host.goto(FRONTEND);
    await host
      .getByRole("button", { name: "New Meeting", exact: true })
      .click();
    await expect(host).toHaveURL(/\/meeting\/\d{11}$/);
    const invite = host.url();
    code = invite.split("/").pop()!;
    token = await host.evaluate(
      (code) => localStorage.getItem(`zoom:host:${code}`)!,
      code,
    );
    expect((await request.get(`${API}/api/meetings/${code}`)).status()).toBe(
      200,
    );
    await enter(host, invite, "Release host", true);
    await expect(host.locator(".media-connection")).toHaveAttribute(
      "data-state",
      "waiting",
    );
    await host
      .getByRole("button", { name: "More meeting controls", exact: true })
      .click();
    await host.getByRole("button", { name: "Invite", exact: true }).click();
    expect(await host.evaluate(() => navigator.clipboard.readText())).toBe(
      invite,
    );
    await enter(guest, invite, "Release guest");
    for (const page of [host, guest]) await media(page);
    const rtc = await (await request.get(`${API}/api/rtc-config`)).json();
    expect(rtc.max_participants).toBe(4);
    const configurationMatches = await host.evaluate((rtc) => {
      const pc = (window as unknown as { __release: Probe }).__release.peers[0];
      const normalize = (servers: RTCIceServer[]) =>
        servers.map((server) => ({
          urls: Array.isArray(server.urls) ? server.urls : [server.urls],
          username: server.username ?? "",
          credential: server.credential ?? "",
        }));
      return (
        JSON.stringify(normalize(pc.getConfiguration().iceServers ?? [])) ===
        JSON.stringify(normalize(rtc.ice_servers))
      );
    }, rtc);
    expect(configurationMatches).toBe(true);
    const mediaEvidence = {
      host: await stats(host),
      guest: await stats(guest),
    };
    await fs.writeFile(
      path.join(evidence, "media.json"),
      JSON.stringify(mediaEvidence, null, 2),
    );
    await host.screenshot({ path: path.join(evidence, "meeting-1440.png") });
    for (const width of [768, 390]) {
      await guest.setViewportSize({
        width,
        height: width === 390 ? 844 : 1000,
      });
      expect(
        await guest.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await guest.screenshot({
        path: path.join(evidence, `meeting-${width}.png`),
      });
    }
    await guest.setViewportSize({ width: 1440, height: 900 });
    // Animate the synthetic screen so frames continue after the sender attaches it.
    await host.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#1565e0";
        context.fillRect(0, 0, 640, 360);
        const stream = canvas.captureStream(15);
        (window as unknown as { __release: Probe }).__release.streams.push(
          stream,
        );
        const track = stream.getVideoTracks()[0];
        let frame = 0;
        const paint = () => {
          if (track.readyState !== "live") return;
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
    await expect(guest.locator(".screen-tile")).toBeVisible();
    await expect
      .poll(() =>
        guest
          .locator(".screen-tile video")
          .evaluate((video: HTMLVideoElement) => {
            const canvas = document.createElement("canvas");
            canvas.width = 1;
            canvas.height = 1;
            const context = canvas.getContext("2d")!;
            context.drawImage(video, 0, 0, 1, 1);
            const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
            return b > 150 && b > r * 2 && g > 50;
          }),
      )
      .toBe(true);
    await host
      .getByRole("button", { name: "Stop sharing screen", exact: true })
      .click();
    await expect(guest.locator(".screen-tile")).toHaveCount(0);
    for (const page of [host, guest]) {
      await page
        .getByRole("button", { name: "Show chat", exact: true })
        .click();
      await page
        .getByLabel("Message everyone", { exact: true })
        .fill(`Message from ${page === host ? "host" : "guest"} <b>plain</b>`);
      await page.getByRole("button", { name: "Send", exact: true }).click();
    }
    for (const page of [host, guest]) {
      await expect(page.getByRole("log", { name: "Messages" })).toContainText(
        "Message from host <b>plain</b>",
      );
      await expect(page.getByRole("log", { name: "Messages" })).toContainText(
        "Message from guest <b>plain</b>",
      );
      await expect(page.locator(".chat-message b")).toHaveCount(0);
      await page
        .getByRole("button", { name: "Close chat", exact: true })
        .click();
    }
    await guest.evaluate(() =>
      (window as unknown as { __release: Probe }).__release.sockets[0].send(
        JSON.stringify({ type: "mute-all" }),
      ),
    );
    await expect
      .poll(() =>
        guest.evaluate(() =>
          (window as unknown as { __release: Probe }).__release.messages.some(
            (m) => m.type === "error",
          ),
        ),
      )
      .toBe(true);
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
    await guest
      .getByRole("button", { name: "Stop video", exact: true })
      .click();
    await expect(
      host
        .locator(".video-tile")
        .filter({ hasText: "Release guest" })
        .locator(".tile-placeholder"),
    ).toBeVisible();
    await guest
      .getByRole("button", { name: "Start video", exact: true })
      .click();
    await guest.getByRole("button", { name: "Leave", exact: true }).click();
    await clean(guest);
    await expect(host.locator(".video-tile")).toHaveCount(1);
    await guest.goto(`${FRONTEND}/join`);
    await guest
      .getByLabel("Meeting ID or invitation link")
      .fill(code.replace(/^(\d{3})(\d{4})(\d{4})$/, "$1 $2 $3"));
    await guest.getByLabel("Your name", { exact: true }).fill("Release guest");
    await guest
      .getByRole("button", { name: "Join Meeting", exact: true })
      .click();
    await enter(guest, invite, "Release guest");
    await media(guest);
    await host
      .getByRole("button", { name: "Remove Release guest", exact: true })
      .click();
    await host
      .getByRole("button", { name: "Remove Participant", exact: true })
      .click();
    await expect(
      guest.getByRole("heading", {
        name: "The host removed you from this meeting.",
      }),
    ).toBeVisible();
    await clean(guest);
    await enter(guest, invite, "Release guest");
    await media(guest);
    await guest.reload();
    await enter(guest, invite, "Release guest");
    await media(guest);
    await host.getByRole("button", { name: "End", exact: true }).click();
    await host
      .getByRole("button", { name: "End Meeting for All", exact: true })
      .click();
    await expect(
      guest.getByRole("heading", { name: "This meeting has ended." }),
    ).toBeVisible();
    await clean(guest);
    await clean(host);
    expect(
      (await (await request.get(`${API}/api/meetings/${code}`)).json()).status,
    ).toBe("ended");
    expect(errors).toEqual([]);
  } finally {
    if (code && token)
      await request.post(`${API}/api/meetings/${code}/end`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("failed ICE stays distinct from signaling and retry restores transport", async ({
  browser,
  request,
}) => {
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
  const [host, guest] = await Promise.all(
    contexts.map((context) => context.newPage()),
  );
  try {
    for (const page of [host, guest]) await probe(page, true);
    await host.goto(FRONTEND);
    await host.evaluate(
      ({ code, token }) => localStorage.setItem(`zoom:host:${code}`, token),
      { code: created.meeting.meeting_code, token: created.host_token },
    );
    await enter(host, created.meeting.invite_url, "Recovery host", true);
    await enter(guest, created.meeting.invite_url, "Recovery guest");
    await expect(guest.locator(".media-connection")).toHaveAttribute(
      "data-state",
      "failed",
      { timeout: 45000 },
    );
    await expect(guest.locator(".room-connection")).toContainText(
      "Signaling: Connected",
    );
    await guest
      .getByRole("button", { name: "Copy connection diagnostics" })
      .click();
    const diagnostics = await guest.evaluate(() =>
      navigator.clipboard.readText(),
    );
    expect(diagnostics).not.toMatch(
      /candidate:|ice-pwd|credential|username|address|sdp/i,
    );
    for (const page of [host, guest])
      await page.evaluate(() => {
        (window as unknown as { __release: Probe }).__release.blocked = false;
      });
    await guest.getByRole("button", { name: "Retry media connection" }).click();
    for (const page of [host, guest]) await media(page);
    await fs.writeFile(
      path.join(evidence, "recovery.json"),
      JSON.stringify(
        { host: await stats(host), guest: await stats(guest) },
        null,
        2,
      ),
    );
  } finally {
    await request.post(
      `${API}/api/meetings/${created.meeting.meeting_code}/end`,
      { headers: { Authorization: `Bearer ${created.host_token}` } },
    );
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("production admission rejects invalid and revoked sessions and oversized WebSockets", async ({
  page,
  request,
}) => {
  const response = await request.post(`${API}/api/meetings/instant`);
  expect(response.status()).toBe(201);
  const created = await response.json();
  const code = created.meeting.meeting_code;
  const headers = { Authorization: `Bearer ${created.host_token}` };
  try {
    expect(
      (
        await request.post(`${API}/api/meetings/${code}/join`, {
          data: { display_name: " " },
        })
      ).status(),
    ).toBe(422);
    expect(
      (await request.post(`${API}/api/meetings/${code}/end`)).status(),
    ).toBe(403);
    const joined = await (
      await request.post(`${API}/api/meetings/${code}/join`, {
        data: { display_name: "Release admission guest" },
      })
    ).json();
    expect(
      (
        await request.post(`${API}/api/meetings/${code}/end`, {
          headers: { Authorization: `Bearer ${joined.participant_token}` },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await request.post(`${API}/api/meetings/${code}/leave`, {
          headers: { Authorization: `Bearer ${joined.participant_token}` },
        })
      ).status(),
    ).toBe(200);
    await page.goto(FRONTEND);
    const socketUrl = `${API.replace(/^http/, "ws")}/ws/meetings/${code}`;
    for (const token of ["invalid-token", joined.participant_token]) {
      const rejected = await page.evaluate(
        ({ url, token }) =>
          new Promise<{ code: number; error: string }>((resolve, reject) => {
            const socket = new WebSocket(url);
            let error = "";
            const timeout = setTimeout(() => {
              socket.close();
              reject(new Error("Authentication close timed out"));
            }, 15000);
            socket.onopen = () =>
              socket.send(JSON.stringify({ type: "auth", token }));
            socket.onmessage = (event) => {
              error = JSON.parse(event.data).code;
            };
            socket.onclose = (event) => {
              clearTimeout(timeout);
              resolve({ code: event.code, error });
            };
          }),
        { url: socketUrl, token },
      );
      expect(rejected).toEqual({ code: 4401, error: "INVALID_SESSION" });
    }
    const oversizedClose = await page.evaluate(
      (url) =>
        new Promise<number>((resolve, reject) => {
          const socket = new WebSocket(url);
          const timeout = setTimeout(() => {
            socket.close();
            reject(new Error("Oversized transport close timed out"));
          }, 15000);
          socket.onopen = () => socket.send("x".repeat(65537));
          socket.onclose = (event) => {
            clearTimeout(timeout);
            resolve(event.code);
          };
        }),
      socketUrl,
    );
    expect(oversizedClose).toBe(1009);
  } finally {
    await request.post(`${API}/api/meetings/${code}/end`, { headers });
  }
});
