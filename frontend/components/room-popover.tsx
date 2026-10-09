"use client";

import { useEffect, useRef, type ReactNode } from "react";

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
