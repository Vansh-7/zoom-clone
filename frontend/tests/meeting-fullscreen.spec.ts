import { test, expect } from "@playwright/test";
import {
  fullscreenBounds,
  toggleMeetingFullscreen,
} from "./helpers/fullscreen";

const API = process.env.E2E_API_URL ?? "http://127.0.0.1:8000";
const FRONTEND = process.env.E2E_FRONTEND_URL ?? "http://localhost:3000";
test.use({ trace: "off" });

test("meeting-only fullscreen fits 1-4 participants, both views and panels at desktop, tablet and mobile widths", async ({
  browser,
  request,
}) => {
  test.setTimeout(180000);
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
    test.skip(
      !(await host.evaluate(
        () =>
          document.fullscreenEnabled &&
          typeof Element.prototype.requestFullscreen === "function",
      )),
      "This browser environment does not support the standard Fullscreen API.",
    );
    await host.evaluate(
      ({ code, token }) => localStorage.setItem(`zoom:host:${code}`, token),
      { code, token: created.host_token },
    );
    for (const [index, page] of pages.entries()) {
      await page.goto(`${FRONTEND}/meeting/${code}`);
      await page
        .getByLabel("Your name", { exact: true })
        .fill(`Fullscreen ${index}`);
      await page
        .getByRole("button", {
          name: index === 0 ? "Start Meeting" : "Join Meeting",
          exact: true,
        })
        .click();
      await expect(host.locator(".camera-tile")).toHaveCount(index + 1);
      await expect(
        host.getByRole("button", { name: "Toggle full screen", exact: true }),
      ).toHaveCount(0);
      const root = await host.locator(".meeting-room").elementHandle();
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 768, height: 1024 },
        { width: 390, height: 844 },
      ]) {
        await host.setViewportSize(viewport);
        await toggleMeetingFullscreen(host, true);
        await fullscreenBounds(host);
        for (const view of ["Gallery View", "Speaker View"]) {
          await host
            .getByRole("button", { name: "Meeting view", exact: true })
            .click();
          await expect(
            host.getByRole("button", { name: "Exit Fullscreen", exact: true }),
          ).toHaveCount(1);
          await host.getByRole("button", { name: view, exact: true }).click();
          if (view === "Speaker View") {
            await host
              .getByLabel("Spotlight participant", { exact: true })
              .selectOption({ label: `Fullscreen ${index}` });
            await host
              .getByRole("button", { name: "Meeting view", exact: true })
              .click();
            await expect(
              host.locator(".speaker-primary .tile-name"),
            ).toContainText(`Fullscreen ${index}`);
          }
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
          if (index === 3)
            await host.screenshot({
              path: `../artifacts/fullscreen-${view === "Gallery View" ? "gallery" : "speaker"}-${viewport.width}.png`,
            });
        }
        await host
          .getByRole("button", { name: "Meeting information", exact: true })
          .click();
        await expect(
          host.getByRole("dialog", { name: "Meeting information" }),
        ).toBeVisible();
        await host
          .getByRole("button", { name: "Meeting information", exact: true })
          .click();
        await host
          .getByRole("button", { name: "Reactions", exact: true })
          .click();
        await expect(
          host.getByRole("button", { name: "Raise Hand", exact: true }),
        ).toBeVisible();
        await host
          .getByRole("button", { name: "Reactions", exact: true })
          .click();
        await host.getByRole("button", { name: "End", exact: true }).click();
        await expect(
          host.getByRole("dialog", { name: "End this meeting?" }),
        ).toBeVisible();
        await host.getByRole("button", { name: "Cancel", exact: true }).click();
        await toggleMeetingFullscreen(host, false);
        expect(
          await root!.evaluate(
            (element) => element === document.querySelector(".meeting-room"),
          ),
        ).toBe(true);
        await host
          .getByRole("button", { name: "Meeting view", exact: true })
          .click();
        await host
          .getByRole("button", { name: "Gallery View", exact: true })
          .click();
      }
    }
    // A browser exit (including Esc) must update the menu through fullscreenchange.
    await toggleMeetingFullscreen(host, true);
    await host.evaluate(() => document.exitFullscreen());
    await host
      .getByRole("button", { name: "Meeting view", exact: true })
      .click();
    await expect(
      host.getByRole("button", { name: "Fullscreen", exact: true }),
    ).toBeVisible();
    await expect(
      host.getByRole("button", { name: "Exit Fullscreen", exact: true }),
    ).toHaveCount(0);
  } finally {
    await request.post(`${API}/api/meetings/${code}/end`, {
      headers: { Authorization: `Bearer ${created.host_token}` },
    });
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("fullscreen handles unsupported and denied browser requests without leaving the meeting", async ({
  page,
  request,
}) => {
  const created = await (
    await request.post(`${API}/api/meetings/instant`)
  ).json();
  const code = created.meeting.meeting_code;
  try {
    await page.goto(FRONTEND);
    await page.evaluate(
      ({ code, token }) => localStorage.setItem(`zoom:host:${code}`, token),
      { code, token: created.host_token },
    );
    await page.goto(`${FRONTEND}/meeting/${code}`);
    await page
      .getByLabel("Your name", { exact: true })
      .fill("Fullscreen fallback");
    await page
      .getByRole("button", { name: "Start Meeting", exact: true })
      .click();
    const root = await page.locator(".meeting-room").elementHandle();
    await page.evaluate(() =>
      Object.defineProperty(
        document.querySelector(".meeting-room"),
        "requestFullscreen",
        { configurable: true, value: undefined },
      ),
    );
    await page
      .getByRole("button", { name: "Meeting view", exact: true })
      .click();
    await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await expect(page.locator('.room-error[role="alert"]')).toContainText(
      "Fullscreen isn't available",
    );
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await page.evaluate(() => {
      Object.defineProperty(document, "fullscreenEnabled", {
        configurable: true,
        value: true,
      });
      Object.defineProperty(
        document.querySelector(".meeting-room"),
        "requestFullscreen",
        {
          configurable: true,
          value: () =>
            Promise.reject(new DOMException("Policy", "NotAllowedError")),
        },
      );
    });
    await page
      .getByRole("button", { name: "Meeting view", exact: true })
      .click();
    await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await expect(page.locator('.room-error[role="alert"]')).toContainText(
      "Fullscreen was blocked",
    );
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    expect(
      await root!.evaluate(
        (element) => element === document.querySelector(".meeting-room"),
      ),
    ).toBe(true);
    await expect(page.locator(".room-connection").first()).toContainText(
      "Connected",
    );
  } finally {
    await request.post(`${API}/api/meetings/${code}/end`, {
      headers: { Authorization: `Bearer ${created.host_token}` },
    });
  }
});
