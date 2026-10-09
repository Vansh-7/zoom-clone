"use client";

import { useCallback, useEffect, useRef, useState } from "react";

function permissionMessage(error: unknown, kind: "audio" | "video") {
  const device = kind === "audio" ? "microphone" : "camera";
  if (error instanceof DOMException && error.name === "NotSupportedError")
    return `${device === "camera" ? "Camera" : "Microphone"} access is unavailable in this browser. Use HTTPS or a supported browser, or join without it.`;
  if (error instanceof DOMException && error.name === "OverconstrainedError")
    return `The selected ${device} is unavailable. Choose another device or the default.`;
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
  const lifecycle = useRef(0);
  const requests = useRef({ audio: 0, video: 0 });
  const pendingKinds = useRef(new Set<"audio" | "video">());
  const enumeration = useRef(0);
  const selected = useRef({ audio: "", video: "" });
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [videoEnabled, setVideoEnabled] = useState(false);
  const [pending, setPending] = useState(false);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceIds, setDeviceIds] = useState({ audio: "", video: "" });

  const refreshDevices = useCallback(async () => {
    const request = ++enumeration.current;
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const available = await navigator.mediaDevices.enumerateDevices();
      if (!alive.current || request !== enumeration.current) return;
      setDevices(
        available.filter((device) =>
          ["audioinput", "videoinput"].includes(device.kind),
        ),
      );
      for (const kind of ["audio", "video"] as const) {
        if (
          selected.current[kind] &&
          !available.some(
            (device) => device.deviceId === selected.current[kind],
          )
        )
          selected.current[kind] = "";
      }
      setDeviceIds({ ...selected.current });
      setIssues((previous) => {
        const next = { ...previous };
        delete next.devices;
        return next;
      });
    } catch {
      if (alive.current && request === enumeration.current)
        setIssues((previous) => ({
          ...previous,
          devices:
            "Device selection is unavailable. You can still use the default camera and microphone.",
        }));
    }
  }, []);

  const cancelPending = useCallback(() => {
    lifecycle.current++;
    requests.current.audio++;
    requests.current.video++;
    enumeration.current++;
    pendingKinds.current.clear();
  }, []);
  const stop = useCallback(() => {
    cancelPending();
    setPending(false);
    current.current?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    current.current = null;
    setStream(null);
    setAudioEnabled(false);
    setVideoEnabled(false);
  }, [cancelPending]);
  useEffect(() => {
    alive.current = true;
    const devices = navigator.mediaDevices;
    void refreshDevices();
    devices?.addEventListener?.("devicechange", refreshDevices);
    return () => {
      alive.current = false;
      cancelPending();
      devices?.removeEventListener?.("devicechange", refreshDevices);
      current.current?.getTracks().forEach((track) => track.stop());
      current.current = null;
    };
  }, [refreshDevices, cancelPending]);

  const acquire = useCallback(
    async (kind: "audio" | "video", deviceId = selected.current[kind]) => {
      if (pendingKinds.current.has(kind)) return;
      const request = ++requests.current[kind];
      pendingKinds.current.add(kind);
      setPending(true);
      try {
        if (!navigator.mediaDevices?.getUserMedia)
          throw new DOMException(
            "Capture API unavailable",
            "NotSupportedError",
          );
        const result = await navigator.mediaDevices.getUserMedia(
          kind === "audio"
            ? {
                audio: {
                  echoCancellation: true,
                  noiseSuppression: true,
                  ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
                },
                video: false,
              }
            : {
                video: {
                  width: { ideal: 1280 },
                  height: { ideal: 720 },
                  ...(deviceId
                    ? { deviceId: { exact: deviceId } }
                    : { facingMode: "user" }),
                },
                audio: false,
              },
        );
        if (!alive.current || request !== requests.current[kind]) {
          result.getTracks().forEach((track) => track.stop());
          return;
        }
        const retained =
          current.current
            ?.getTracks()
            .filter(
              (track) => track.kind !== kind && track.readyState === "live",
            ) ?? [];
        const previous = current.current
          ?.getTracks()
          .find((track) => track.kind === kind && track.readyState === "live");
        const track = result.getTracks().find((track) => track.kind === kind);
        if (!track || track.readyState !== "live") {
          result.getTracks().forEach((item) => item.stop());
          throw new DOMException("Device unavailable", "NotFoundError");
        }
        track.enabled = previous?.enabled ?? true;
        current.current
          ?.getTracks()
          .filter((track) => track.kind === kind)
          .forEach((track) => track.stop());
        const next = new MediaStream([...retained, ...result.getTracks()]);
        current.current = next;
        setStream(next);
        if (kind === "audio") setAudioEnabled(track.enabled);
        else setVideoEnabled(track.enabled);
        selected.current[kind] = track.getSettings().deviceId ?? deviceId;
        setDeviceIds({ ...selected.current });
        result.getTracks().forEach((track) => {
          track.onended = () => {
            if (alive.current && current.current?.getTracks().includes(track)) {
              if (kind === "audio") setAudioEnabled(false);
              else setVideoEnabled(false);
              setIssues((previous) => ({
                ...previous,
                [kind]: `Your ${kind === "audio" ? "microphone" : "camera"} disconnected. Choose another device or join without it.`,
              }));
              void refreshDevices();
            }
          };
        });
        setIssues((previous) => {
          const next = { ...previous };
          delete next[kind];
          return next;
        });
        void refreshDevices();
      } catch (error) {
        if (alive.current && request === requests.current[kind])
          setIssues((previous) => ({
            ...previous,
            [kind]: permissionMessage(error, kind),
          }));
      } finally {
        if (alive.current && request === requests.current[kind]) {
          pendingKinds.current.delete(kind);
          setPending(pendingKinds.current.size > 0);
        }
      }
    },
    [refreshDevices],
  );

  const enableBoth = useCallback(async () => {
    if (pendingKinds.current.size) return;
    const version = lifecycle.current;
    await acquire("video");
    if (alive.current && version === lifecycle.current) await acquire("audio");
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
        await acquire(kind);
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
    devices,
    deviceIds,
    selectDevice: acquire,
    enableBoth,
    toggleAudio: () => toggle("audio"),
    toggleVideo: () => toggle("video"),
    muteAudio,
    stop,
  };
}
