"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Volume2 } from "lucide-react";

function AudioTrack({
  id,
  stream,
  register,
  report,
}: {
  id: string;
  stream: MediaStream;
  register: (id: string, element: HTMLAudioElement | null) => void;
  report: (id: string, blocked: boolean) => void;
}) {
  const element = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const audio = element.current!;
    let active = true;
    audio.muted = false;
    audio.volume = 1;
    const play = () => {
      if (!audio.srcObject) return;
      void audio.play().then(
        () => {
          if (active) report(id, false);
        },
        (error: DOMException) => {
          if (active && error.name !== "AbortError") report(id, true);
        },
      );
    };
    const observed = new Set<MediaStreamTrack>();
    const refresh = () => {
      const tracks = stream
        .getAudioTracks()
        .filter((track) => track.readyState === "live");
      for (const track of tracks) {
        if (observed.has(track)) continue;
        observed.add(track);
        track.addEventListener("unmute", play);
        track.addEventListener("ended", refresh);
      }
      const previous =
        (audio.srcObject as MediaStream | null)?.getAudioTracks() ?? [];
      if (
        tracks.length !== previous.length ||
        tracks.some((track, index) => track !== previous[index])
      )
        audio.srcObject = tracks.length ? new MediaStream(tracks) : null;
      if (tracks.length) play();
      else report(id, false);
    };
    // Safari can pause when a late audio track becomes playable, without rejecting
    // the earlier play() promise. Observe both track readiness and element playback.
    audio.addEventListener("pause", play);
    audio.addEventListener("canplay", play);
    stream.addEventListener("addtrack", refresh);
    stream.addEventListener("removetrack", refresh);
    refresh();
    return () => {
      active = false;
      audio.removeEventListener("pause", play);
      audio.removeEventListener("canplay", play);
      stream.removeEventListener("addtrack", refresh);
      stream.removeEventListener("removetrack", refresh);
      for (const track of observed) {
        track.removeEventListener("unmute", play);
        track.removeEventListener("ended", refresh);
      }
    };
  }, [stream, id, report]);
  useEffect(() => {
    const audio = element.current!;
    return () => {
      audio.pause();
      audio.srcObject = null;
      report(id, false);
    };
  }, [id, report]);
  return (
    <audio
      autoPlay
      data-participant-id={id}
      aria-label={`Participant ${id} audio`}
      ref={(node) => {
        element.current = node;
        register(id, node);
      }}
    />
  );
}

export function RemoteAudio({
  streams,
}: {
  streams: Record<number, MediaStream>;
}) {
  const elements = useRef(new Map<string, HTMLAudioElement>());
  const [blocked, setBlocked] = useState<Record<string, boolean>>({});
  const register = useCallback(
    (id: string, element: HTMLAudioElement | null) => {
      if (element) elements.current.set(id, element);
      else elements.current.delete(id);
    },
    [],
  );
  const report = useCallback((id: string, value: boolean) => {
    setBlocked((current) =>
      current[id] === value ? current : { ...current, [id]: value },
    );
  }, []);
  function enable() {
    // Call every play() synchronously within this click, before any await, so
    // Safari's user activation applies to all participants rather than only one.
    elements.current.forEach((audio, id) => {
      if (!audio.srcObject) return;
      audio.muted = false;
      audio.volume = 1;
      void audio.play().then(
        () => report(id, false),
        () => report(id, true),
      );
    });
  }
  return (
    <div className="remote-audio">
      {Object.entries(streams).map(([id, stream]) => (
        <AudioTrack
          key={id}
          id={id}
          stream={stream}
          register={register}
          report={report}
        />
      ))}
      {Object.keys(streams).some((id) => blocked[id]) && (
        <div className="audio-playback-notice" role="status">
          <Volume2 size={18} />
          <span>Your browser paused meeting audio.</span>
          <button className="button primary" onClick={enable}>
            Enable Audio
          </button>
        </div>
      )}
    </div>
  );
}
