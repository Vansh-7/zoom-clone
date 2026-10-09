"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

export function RoomPopover({
  trigger,
  children,
  open,
  onClose,
  label,
  placement = "above",
}: {
  trigger: ReactNode;
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  label: string;
  placement?: "above" | "below";
}) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const node = root.current!;
    const panel = node.querySelector<HTMLElement>(".room-popover")!;
    const room = node.closest(".meeting-room")!;
    const position = () => {
      const bounds = room.getBoundingClientRect();
      const anchor = node.getBoundingClientRect();
      const left = Math.max(8, bounds.left + 8);
      const right = Math.min(innerWidth - 8, bounds.right - 8);
      const top = Math.max(8, bounds.top + 8);
      const bottom = Math.min(innerHeight - 8, bounds.bottom - 8);
      panel.style.maxWidth = `${right - left}px`;
      panel.style.maxHeight = `${Math.max(0, placement === "above" ? anchor.top - top - 8 : bottom - anchor.bottom - 10)}px`;
      panel.style.setProperty("--popover-offset-x", "0px");
      const box = panel.getBoundingClientRect();
      const shift = Math.max(left - box.left, Math.min(0, right - box.right));
      panel.style.setProperty("--popover-offset-x", `${shift}px`);
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(room);
    observer.observe(panel);
    window.addEventListener("resize", position);
    document.addEventListener("fullscreenchange", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      document.removeEventListener("fullscreenchange", position);
    };
  }, [open, placement]);
  useEffect(() => {
    if (!open) return;
    const node = root.current!;
    const closeOutside = (event: PointerEvent) => {
      if (!node.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
      node.querySelector<HTMLButtonElement>(":scope > button")?.focus();
    };
    node
      .querySelector<HTMLElement>(".room-popover button, .room-popover select")
      ?.focus();
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, onClose]);
  return (
    <div className={`room-popover-anchor popover-${placement}`} ref={root}>
      {trigger}
      {open && (
        <div className="room-popover" role="dialog" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}
