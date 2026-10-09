import { test, expect, type Page } from "@playwright/test";
import type { ChatMessage } from "../types";

const API = process.env.E2E_API_URL ?? "http://127.0.0.1:8000";
const FRONTEND = process.env.E2E_FRONTEND_URL ?? "http://localhost:3000";
test.use({ trace: "off" });

declare global {
  interface Window {
    __chatProbe: { selfId?: number; received: ChatMessage[]; sent: unknown[] };
  }
}

async function probe(page: Page) {
  await page.addInitScript(() => {
    window.__chatProbe = { received: [], sent: [] };
    const Socket = window.WebSocket;
    window.WebSocket = class extends Socket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);
          if (message.type === "welcome")
            window.__chatProbe.selfId = message.self_id;
          if (message.type === "chat")
            window.__chatProbe.received.push(message.chat);
        });
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === "string") {
          const message = JSON.parse(data);
          if (message.type === "chat") window.__chatProbe.sent.push(message);
        }
        super.send(data);
      }
    };
  });
}

async function join(page: Page, code: string, name: string, host = false) {
  await page.goto(`${FRONTEND}/meeting/${code}`);
  await page.getByLabel("Your name", { exact: true }).fill(name);
  await page
    .getByRole("button", {
      name: host ? "Start Meeting" : "Join Meeting",
      exact: true,
    })
    .click();
  await expect(page.locator(".room-connection").first()).toContainText(
    "Connected",
  );
  await page.getByRole("button", { name: "Show chat", exact: true }).click();
}

async function send(page: Page, text: string) {
  await page.locator(".chat-compose textarea").fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page
      .getByRole("log", { name: "Messages" })
      .getByText(text, { exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(550); // The existing server throttle covers every conversation.
}

test("four-person private chat isolates delivery, histories, unread counts and rejoined sessions", async ({
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
  const [host, alice, bob, carol] = pages;
  try {
    for (const page of pages) await probe(page);
    await host.goto(FRONTEND);
    await host.evaluate(
      ({ code, token }) => localStorage.setItem(`zoom:host:${code}`, token),
      { code, token: created.host_token },
    );
    for (const [index, page] of pages.entries())
      await join(
        page,
        code,
        ["Host", "Alice", "Bob", "Carol"][index],
        index === 0,
      );
    const ids = await Promise.all(
      pages.map((page) => page.evaluate(() => window.__chatProbe.selfId!)),
    );
    for (const [index, page] of pages.entries()) {
      await expect(page.getByLabel("Chat recipient")).toHaveValue("everyone");
      await expect(page.locator("#chat-recipient option")).toHaveCount(4);
      await expect(
        page.locator(`#chat-recipient option[value="${ids[index]}"]`),
      ).toHaveCount(0);
    }
    await send(host, "Welcome, everyone");
    for (const page of pages)
      await expect(page.getByRole("log")).toContainText("Welcome, everyone");
    await bob.getByRole("button", { name: "Close chat", exact: true }).click();
    await alice.getByLabel("Chat recipient").selectOption(String(ids[2]));
    await send(alice, "Alice and Bob only");
    await bob.getByRole("button", { name: "Show chat", exact: true }).click();
    await expect(bob.getByRole("log")).not.toContainText("Alice and Bob only");
    await bob
      .getByRole("button", { name: "Alice (1 unread)", exact: true })
      .click();
    await expect(bob.getByRole("log")).toContainText("Alice and Bob only");
    await expect(bob.locator(".chat-private")).toHaveText("Private");
    await expect(bob.locator(".chat-unread-conversations")).toHaveCount(0);
    await send(bob, "Private reply to Alice");
    await expect(alice.getByRole("log")).toContainText(
      "Private reply to Alice",
    );
    // Inspect actual socket delivery, not just UI filtering; the host is a bystander.
    for (const page of [host, carol]) {
      expect(
        await page.evaluate(() =>
          window.__chatProbe.received.filter(
            (message) => message.recipient_id !== null,
          ),
        ),
      ).toEqual([]);
    }
    await alice.locator(".chat-compose textarea").fill("Unsent private draft");
    await alice.getByLabel("Chat recipient").selectOption("everyone");
    await expect(alice.locator(".chat-compose textarea")).toHaveValue("");
    await expect(alice.getByRole("log")).not.toContainText(
      "Alice and Bob only",
    );
    await send(alice, "Group update after private chat");
    for (const page of [host, carol])
      await expect(page.getByRole("log")).toContainText(
        "Group update after private chat",
      );
    await expect(bob.getByRole("log")).not.toContainText(
      "Group update after private chat",
    );
    await expect(
      bob.getByRole("button", {
        name: "Everyone (Group Chat) (1 unread)",
        exact: true,
      }),
    ).toBeVisible();
    await bob
      .getByRole("button", {
        name: "Everyone (Group Chat) (1 unread)",
        exact: true,
      })
      .click();
    await expect(bob.getByRole("log")).toContainText(
      "Group update after private chat",
    );
    await expect(bob.getByRole("log")).not.toContainText("Alice and Bob only");
    await alice.getByLabel("Chat recipient").selectOption(String(ids[2]));
    await expect(alice.locator(".chat-compose textarea")).toHaveValue(
      "Unsent private draft",
    );
    await carol.getByLabel("Chat recipient").selectOption(String(ids[0]));
    await send(carol, "Carol and Host only");
    await expect(
      host.getByRole("button", { name: "Carol (1 unread)", exact: true }),
    ).toBeVisible();
    for (const page of [alice, bob]) {
      expect(
        await page.evaluate(() =>
          window.__chatProbe.received.some(
            (message) => message.text === "Carol and Host only",
          ),
        ),
      ).toBe(false);
    }
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      await alice.setViewportSize(viewport);
      await alice.getByLabel("Chat recipient").click({ trial: true });
      await alice
        .getByRole("button", { name: "Send", exact: true })
        .click({ trial: true });
      await alice.screenshot({
        path: `../artifacts/private-chat-${viewport.width}.png`,
      });
      const layout = await alice.evaluate(() => {
        const selector = document
          .querySelector("#chat-recipient")!
          .getBoundingClientRect();
        const panel = document
          .querySelector(".chat-panel")!
          .getBoundingClientRect();
        const toolbar = document
          .querySelector(".meeting-toolbar")!
          .getBoundingClientRect();
        const sendButton = document
          .querySelector(".chat-send button")!
          .getBoundingClientRect();
        return {
          selector: selector.toJSON(),
          send: sendButton.toJSON(),
          panel: panel.toJSON(),
          toolbar: toolbar.toJSON(),
          safe:
            selector.left >= panel.left &&
            selector.right <= panel.right &&
            selector.bottom <= panel.bottom &&
            sendButton.bottom <= panel.bottom &&
            panel.bottom <= toolbar.top + 1 &&
            document.documentElement.scrollWidth <= innerWidth,
        };
      });
      expect(layout.safe, JSON.stringify(layout)).toBe(true);
    }
    await bob.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(alice.locator(".chat-unavailable")).toContainText(
      "This participant left",
    );
    await expect(alice.locator(".chat-compose textarea")).toBeDisabled();
    await expect(alice.getByLabel("Chat recipient")).toHaveValue(
      String(ids[2]),
    );
    await join(bob, code, "Bob");
    const newId = await bob.evaluate(() => window.__chatProbe.selfId!);
    expect(newId).not.toBe(ids[2]);
    await expect(
      alice.locator(`#chat-recipient option[value="${newId}"]`),
    ).toBeEnabled();
    await expect(alice.locator(".chat-compose textarea")).toBeDisabled();
    await alice.getByLabel("Chat recipient").selectOption(String(newId));
    await expect(alice.locator(".chat-compose textarea")).toHaveValue("");
    await expect(alice.getByRole("log")).not.toContainText(
      "Alice and Bob only",
    );
    await send(alice, "New Bob session only");
    await bob
      .getByRole("button", { name: "Alice (1 unread)", exact: true })
      .click();
    await expect(bob.getByRole("log")).toContainText("New Bob session only");
    await expect(bob.getByRole("log")).not.toContainText("Alice and Bob only");
    for (const page of [host, carol]) {
      expect(
        await page.evaluate(() =>
          window.__chatProbe.received.some(
            (message) => message.text === "New Bob session only",
          ),
        ),
      ).toBe(false);
    }
  } finally {
    await request.post(`${API}/api/meetings/${code}/end`, {
      headers: { Authorization: `Bearer ${created.host_token}` },
    });
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("private chat fails closed with a server that does not advertise support", async ({
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
    await probe(host);
    await host.routeWebSocket("**/ws/meetings/**", (route) => {
      const server = route.connectToServer();
      server.onMessage((data) => {
        const message = JSON.parse(String(data));
        if (message.type === "welcome") delete message.capabilities;
        route.send(JSON.stringify(message));
      });
    });
    await host.goto(FRONTEND);
    await host.evaluate(
      ({ code, token }) => localStorage.setItem(`zoom:host:${code}`, token),
      { code, token: created.host_token },
    );
    await join(host, code, "Host", true);
    await join(guest, code, "Guest");
    await expect(
      host.getByText("Private chat is unavailable on this meeting server."),
    ).toBeVisible();
    await expect(
      host.locator("#chat-recipient option").filter({ hasText: "Guest" }),
    ).toBeDisabled();
    await send(host, "Group chat still works");
    await expect(guest.getByRole("log")).toContainText(
      "Group chat still works",
    );
    expect(await host.evaluate(() => window.__chatProbe.sent)).toEqual([
      { type: "chat", text: "Group chat still works", recipient_id: null },
    ]);
  } finally {
    await request.post(`${API}/api/meetings/${code}/end`, {
      headers: { Authorization: `Bearer ${created.host_token}` },
    });
    await Promise.all(contexts.map((context) => context.close()));
  }
});
