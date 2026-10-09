import { test, expect, type Page } from "@playwright/test";

const API = process.env.E2E_API_URL ?? "http://127.0.0.1:8000";
const FRONTEND = process.env.E2E_FRONTEND_URL ?? "http://localhost:3000";

interface DeviceProbe {
  streams: MediaStream[];
  peers: RTCPeerConnection[];
  calls: { kind: "audio" | "video"; id: string }[];
  fail?: "denied" | "unavailable";
  removed?: boolean;
  delay?: boolean;
  release?: () => void;
}
declare global {
  interface Window {
    __devices: DeviceProbe;
  }
}

async function devices(page: Page) {
  await page.addInitScript(() => {
    window.__devices = { streams: [], peers: [], calls: [] };
    // Alias two inputs to real synthetic capture. Physical hardware selection is a separate check.
    navigator.mediaDevices.enumerateDevices = async () =>
      ["video", "audio"]
        .flatMap((kind) =>
          ["a", "b"].map((suffix) => ({
            kind: `${kind}input`,
            deviceId: `${kind}-${suffix}`,
            label: `${kind === "video" ? "Camera" : "Microphone"} ${suffix.toUpperCase()}`,
            groupId: "test",
            toJSON: () => ({}),
          })),
        )
        .filter(
          (device) =>
            !(window.__devices.removed && device.deviceId === "video-b"),
        ) as MediaDeviceInfo[];
    const capture = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints = {}) => {
      const kind = constraints.video ? "video" : "audio";
      const constraint = constraints[kind] as MediaTrackConstraints;
      const requested =
        (constraint.deviceId as { exact?: string })?.exact ?? `${kind}-a`;
      window.__devices.calls.push({ kind, id: requested });
      if (window.__devices.fail)
        throw new DOMException(
          "Fixture rejection",
          window.__devices.fail === "denied"
            ? "NotAllowedError"
            : "OverconstrainedError",
        );
      const stream = await capture({
        video:
          kind === "video" ? { width: 640, height: 360, frameRate: 15 } : false,
        audio: kind === "audio",
      });
      window.__devices.streams.push(stream);
      for (const track of stream.getTracks()) {
        const settings = track.getSettings.bind(track);
        track.getSettings = () => ({ ...settings(), deviceId: requested });
      }
      if (window.__devices.delay)
        await new Promise<void>((resolve) => {
          window.__devices.release = resolve;
        });
      return stream;
    };
    const Peer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer {
      constructor(config?: RTCConfiguration) {
        super(config);
        window.__devices.peers.push(this);
      }
    };
  });
  await page.route("**/api/rtc-config", (route) =>
    route.fulfill({ json: { ice_servers: [], ice_transport_policy: "all" } }),
  );
}

async function live(page: Page) {
  return page.evaluate(() =>
    window.__devices.streams
      .flatMap((stream) => stream.getTracks())
      .filter((track) => track.readyState === "live")
      .map((track) => ({
        id: track.id,
        kind: track.kind,
        enabled: track.enabled,
        device: track.getSettings().deviceId,
      })),
  );
}

test("device switching preserves mute, keeps the old input on failure, and carries chosen tracks into the call", async ({
  browser,
  request,
}) => {
  const created = await (
    await request.post(`${API}/api/meetings/instant`)
  ).json();
  const code = created.meeting.meeting_code;
  const contexts = await Promise.all(
    [0, 1].map(() =>
      browser.newContext({ permissions: ["camera", "microphone"] }),
    ),
  );
  const [host, guest] = await Promise.all(
    contexts.map((context) => context.newPage()),
  );
  try {
    for (const page of [host, guest]) {
      await devices(page);
      await page.goto(`${FRONTEND}/meeting/${code}`);
    }
    await host.evaluate(
      ({ code, token }) => localStorage.setItem(`zoom:host:${code}`, token),
      { code, token: created.host_token },
    );
    await host.reload();
    await host.getByLabel("Your name", { exact: true }).fill("Device host");
    await host
      .getByRole("button", { name: "Enable camera & microphone", exact: true })
      .click();
    await expect(
      host.getByRole("combobox", { name: "Camera", exact: true }),
    ).toHaveValue("video-a");
    await expect(
      host.getByRole("combobox", { name: "Camera", exact: true }),
    ).toBeEnabled();
    await expect.poll(async () => (await live(host)).length).toBe(2);
    const original = await live(host);
    await host
      .getByRole("button", { name: "Mute microphone", exact: true })
      .click();
    await host
      .getByRole("combobox", { name: "Microphone", exact: true })
      .selectOption("audio-b");
    await expect(
      host.getByRole("combobox", { name: "Microphone", exact: true }),
    ).toHaveValue("audio-b");
    const mic = (await live(host)).find((track) => track.kind === "audio")!;
    expect(mic.enabled).toBe(false);
    expect(mic.id).not.toBe(
      original.find((track) => track.kind === "audio")!.id,
    );
    expect((await live(host)).find((track) => track.kind === "video")!.id).toBe(
      original.find((track) => track.kind === "video")!.id,
    );

    for (const fail of ["unavailable", "denied"] as const) {
      await host.evaluate((fail) => {
        window.__devices.fail = fail;
      }, fail);
      await host
        .getByRole("combobox", { name: "Camera", exact: true })
        .selectOption("video-b");
      await expect(host.locator(".media-warning")).toContainText(
        fail === "denied" ? "blocked" : "unavailable",
      );
      await expect(
        host.getByRole("combobox", { name: "Camera", exact: true }),
      ).toHaveValue("video-a");
      expect(
        (await live(host)).find((track) => track.kind === "video")!.id,
      ).toBe(original.find((track) => track.kind === "video")!.id);
    }
    await host.evaluate(() => {
      window.__devices.fail = undefined;
    });
    await host
      .getByRole("combobox", { name: "Camera", exact: true })
      .selectOption("video-b");
    await expect(
      host.getByRole("combobox", { name: "Camera", exact: true }),
    ).toHaveValue("video-b");
    await expect(host.locator(".media-warning")).toHaveCount(0);
    const chosen = await live(host);
    expect(chosen).toHaveLength(2);
    expect(chosen.find((track) => track.kind === "audio")!.id).toBe(mic.id);

    await host
      .getByRole("button", { name: "Start Meeting", exact: true })
      .click();
    await expect(host.locator(".media-connection")).toHaveAttribute(
      "data-state",
      "waiting",
    );
    await guest.setViewportSize({ width: 390, height: 844 });
    await guest.getByLabel("Your name", { exact: true }).fill("Device guest");
    await guest
      .getByRole("button", { name: "Enable camera & microphone", exact: true })
      .click();
    await guest
      .getByRole("button", { name: "Join Meeting", exact: true })
      .click();
    await expect(host.locator(".media-connection")).toHaveAttribute(
      "data-state",
      "connected",
    );
    await expect(guest.locator(".video-tile")).toHaveCount(2);
    for (const tile of await guest.locator(".video-tile").all())
      expect((await tile.boundingBox())!.height).toBeGreaterThan(160);
    expect(
      await host.evaluate(() =>
        window.__devices.peers[0]
          .getSenders()
          .filter((sender) => sender.track)
          .map((sender) => sender.track!.id)
          .sort(),
      ),
    ).toEqual(chosen.map((track) => track.id).sort());
    await host
      .getByRole("button", { name: "Unmute microphone", exact: true })
      .click();
    for (const page of [host, guest]) {
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const totals = { audio: 0, video: 0 };
            for (const peer of window.__devices.peers)
              (await peer.getStats()).forEach((report) => {
                if (report.type === "inbound-rtp" && report.kind === "audio")
                  totals.audio += report.packetsReceived ?? 0;
                if (report.type === "inbound-rtp" && report.kind === "video")
                  totals.video += report.framesDecoded ?? 0;
              });
            return totals.audio > 0 && totals.video > 0;
          }),
        )
        .toBe(true);
    }
    await host.getByRole("button", { name: "End", exact: true }).click();
    await host
      .getByRole("button", { name: "End Meeting for All", exact: true })
      .click();
    for (const page of [host, guest])
      await expect.poll(() => live(page)).toEqual([]);
  } finally {
    await request.post(`${API}/api/meetings/${code}/end`, {
      headers: { Authorization: `Bearer ${created.host_token}` },
    });
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("ending a meeting cancels an unresolved camera request without restarting capture", async ({
  page,
  request,
}) => {
  const created = await (
    await request.post(`${API}/api/meetings/instant`)
  ).json();
  const code = created.meeting.meeting_code;
  await devices(page);
  await page.goto(`${FRONTEND}/meeting/${code}`);
  await page.evaluate(
    ({ code, token }) => localStorage.setItem(`zoom:host:${code}`, token),
    { code, token: created.host_token },
  );
  await page.reload();
  await page.getByLabel("Your name", { exact: true }).fill("Pending host");
  await page
    .getByRole("button", { name: "Start Meeting", exact: true })
    .click();
  await page.evaluate(() => {
    window.__devices.delay = true;
  });
  await page.getByRole("button", { name: "Start video", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => !!window.__devices.release))
    .toBe(true);
  await page.getByRole("button", { name: "End", exact: true }).click();
  await page
    .getByRole("button", { name: "End Meeting for All", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "This meeting has ended.", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.__devices.release!());
  await expect.poll(() => live(page)).toEqual([]);
  expect(await page.evaluate(() => window.__devices.calls.length)).toBe(1);
});

test("mobile prejoin refreshes removed inputs and supports keyboard device selection", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const created = await (
    await request.post(`${API}/api/meetings/instant`)
  ).json();
  const code = created.meeting.meeting_code;
  try {
    await devices(page);
    await page.goto(`${FRONTEND}/meeting/${code}`);
    await page
      .getByRole("button", { name: "Enable camera & microphone", exact: true })
      .click();
    const camera = page.getByRole("combobox", { name: "Camera", exact: true });
    await expect(camera).toBeEnabled();
    await camera.focus();
    await camera.press("End");
    await camera.press("Enter");
    await expect(camera).toHaveValue("video-b");
    await page.evaluate(() => {
      window.__devices.removed = true;
      const track = window.__devices.streams
        .flatMap((stream) => stream.getVideoTracks())
        .find((track) => track.readyState === "live")!;
      track.stop();
      track.dispatchEvent(new Event("ended"));
      navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
    });
    await expect(camera).toHaveValue("");
    await expect(page.locator(".media-warning")).toContainText("disconnected");
    await expect(camera.locator("option[value='video-b']")).toHaveCount(0);
    await camera.selectOption("video-a");
    await expect(camera).toHaveValue("video-a");
    await expect(page.locator(".media-warning")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("link", { name: "Back to Home", exact: true }).click();
    await expect.poll(() => live(page)).toEqual([]);
  } finally {
    await request.post(`${API}/api/meetings/${code}/end`, {
      headers: { Authorization: `Bearer ${created.host_token}` },
    });
  }
});
