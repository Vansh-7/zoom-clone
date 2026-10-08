"use client";

import { useCallback, useEffect, useRef, useState } from "react";

function permissionMessage(error: unknown, kind: "audio" | "video") {
  const device = kind === "audio" ? "microphone" : "camera";
  if (error instanceof DOMException && error.name === "NotAllowedError")
    return `Your ${device} is blocked. Allow access in your browser’s site settings, or join without it.`;
  if (error instanceof DOMException && error.name === "NotFoundError")
    return `No ${device} was found. You can still join the meeting.`;
  if (error instanceof DOMException && error.name === "NotReadableError")
    return `Your ${device} is in use by another app. Close it and try again.`;
  return `We couldn't access your ${device}. You can join without it and try again later.`;
}

export function useLocalMedia() {
  const current = useRef<MediaStream | null>(null);
  const alive = useRef(true);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [videoEnabled, setVideoEnabled] = useState(false);
  const [pending, setPending] = useState(false);
  const [issues, setIssues] = useState<Record<string, string>>({});

  const stop = useCallback(() => {
    current.current?.getTracks().forEach((track) => track.stop());
    current.current = null;
    setStream(null);
    setAudioEnabled(false);
    setVideoEnabled(false);
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      current.current?.getTracks().forEach((track) => track.stop());
      current.current = null;
    };
  }, []);

  const acquire = useCallback(async (kind: "audio" | "video") => {
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("Media requires HTTPS or localhost");
      const result = await navigator.mediaDevices.getUserMedia(
        kind === "audio"
          ? {
              audio: { echoCancellation: true, noiseSuppression: true },
              video: false,
            }
          : {
              video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: "user",
              },
              audio: false,
            },
      );
      if (!alive.current) {
        result.getTracks().forEach((track) => track.stop());
        return;
      }
      const retained =
        current.current
          ?.getTracks()
          .filter(
            (track) => track.kind !== kind && track.readyState === "live",
          ) ?? [];
      current.current
        ?.getTracks()
        .filter((track) => track.kind === kind)
        .forEach((track) => track.stop());
      const next = new MediaStream([...retained, ...result.getTracks()]);
      current.current = next;
      setStream(next);
      if (kind === "audio") setAudioEnabled(true);
      else setVideoEnabled(true);
      result.getTracks().forEach((track) => {
        track.onended = () => {
          if (alive.current) {
            if (kind === "audio") setAudioEnabled(false);
            else setVideoEnabled(false);
          }
        };
      });
      setIssues((previous) => {
        const next = { ...previous };
        delete next[kind];
        return next;
      });
    } catch (error) {
      if (alive.current)
        setIssues((previous) => ({
          ...previous,
          [kind]: permissionMessage(error, kind),
        }));
    }
  }, []);

  const enableBoth = useCallback(async () => {
    setPending(true);
    try {
      await acquire("video");
      await acquire("audio");
    } finally {
      if (alive.current) setPending(false);
    }
  }, [acquire]);

  const toggle = useCallback(
    async (kind: "audio" | "video") => {
      const track = current.current
        ?.getTracks()
        .find((track) => track.kind === kind && track.readyState === "live");
      if (track) {
        track.enabled = !track.enabled;
        if (kind === "audio") setAudioEnabled(track.enabled);
        else setVideoEnabled(track.enabled);
      } else {
        setPending(true);
        await acquire(kind);
        if (alive.current) setPending(false);
      }
    },
    [acquire],
  );
  const muteAudio = useCallback(() => {
    current.current?.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
    setAudioEnabled(false);
  }, []);

  return {
    stream,
    audioEnabled,
    videoEnabled,
    pending,
    issues,
    enableBoth,
    toggleAudio: () => toggle("audio"),
    toggleVideo: () => toggle("video"),
    muteAudio,
    stop,
  };
}
