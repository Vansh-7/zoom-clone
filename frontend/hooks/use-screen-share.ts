"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export function useScreenShare() {
  const capture = useRef<MediaStream | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const requesting = useRef(false);
  const [track, setTrack] = useState<MediaStreamTrack | null>(null);
  const [pending, setPending] = useState(false);

  const stop = useCallback(() => {
    generation.current++;
    capture.current?.getTracks().forEach((item) => {
      item.onended = null;
      item.stop();
    });
    capture.current = null;
    setTrack(null);
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      capture.current?.getTracks().forEach((item) => item.stop());
      capture.current = null;
    };
  }, []);

  async function start() {
    if (requesting.current || capture.current) return;
    if (!navigator.mediaDevices?.getDisplayMedia)
      throw new Error(
        "Screen sharing isn't supported in this browser. Try desktop Chrome or Edge.",
      );
    requesting.current = true;
    setPending(true);
    const request = ++generation.current;
    try {
      // Keep microphone audio unchanged. The browser always owns source selection.
      const result = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 15, max: 30 },
        },
        audio: false,
      });
      if (!alive.current || request !== generation.current) {
        result.getTracks().forEach((item) => item.stop());
        return;
      }
      const video = result.getVideoTracks()[0];
      if (!video || video.readyState !== "live") {
        result.getTracks().forEach((item) => item.stop());
        throw new Error(
          "The selected screen is no longer available. Choose it again.",
        );
      }
      video.contentHint = "detail";
      video.onended = stop;
      capture.current = result;
      setTrack(video);
    } catch (error) {
      if (
        error instanceof DOMException &&
        ["NotAllowedError", "AbortError"].includes(error.name)
      )
        throw new Error(
          "Screen sharing was cancelled or blocked. Your camera is unchanged.",
        );
      throw error;
    } finally {
      requesting.current = false;
      if (alive.current) setPending(false);
    }
  }

  const stream = useMemo(
    () => (track ? new MediaStream([track]) : null),
    [track],
  );
  return { stream, sharing: !!track, pending, start, stop };
}
