import { expect, type Page } from "@playwright/test";

export async function toggleMeetingFullscreen(page: Page, active: boolean) {
  await page.getByRole("button", { name: "Meeting view", exact: true }).click();
  await page
    .getByRole("button", {
      name: active ? "Fullscreen" : "Exit Fullscreen",
      exact: true,
    })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.fullscreenElement ===
          document.querySelector(".meeting-room"),
      ),
    )
    .toBe(active);
}

export async function fullscreenBounds(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const room = document.querySelector<HTMLElement>(".meeting-room")!;
        const box = room.getBoundingClientRect();
        const header = room
          .querySelector(".room-header")!
          .getBoundingClientRect();
        const toolbar = room
          .querySelector(".meeting-toolbar")!
          .getBoundingClientRect();
        return (
          document.fullscreenElement === room &&
          box.x === 0 &&
          box.y === 0 &&
          Math.abs(box.width - innerWidth) <= 1 &&
          Math.abs(box.height - innerHeight) <= 1 &&
          room.scrollHeight <= room.clientHeight + 1 &&
          room.scrollWidth <= room.clientWidth + 1 &&
          Array.from(room.querySelectorAll(".video-tile")).every((tile) => {
            const bounds = tile.getBoundingClientRect();
            return (
              bounds.width > 0 &&
              bounds.height > 0 &&
              bounds.top >= header.bottom - 1 &&
              bounds.bottom <= toolbar.top + 1
            );
          }) &&
          Array.from(room.querySelectorAll(".meeting-toolbar button")).every(
            (button) => {
              const bounds = button.getBoundingClientRect();
              const hit = document.elementFromPoint(
                bounds.x + bounds.width / 2,
                bounds.y + bounds.height / 2,
              );
              return (
                bounds.left >= 0 &&
                bounds.right <= innerWidth &&
                bounds.bottom <= innerHeight &&
                !!hit &&
                button.contains(hit)
              );
            },
          ) &&
          [
            [1, 1],
            [innerWidth - 2, innerHeight - 2],
          ].every(([x, y]) => room.contains(document.elementFromPoint(x, y)))
        );
      }),
    )
    .toBe(true);
}
