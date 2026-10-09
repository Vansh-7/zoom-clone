import { Link2, Signal } from "lucide-react";
import type { Participant } from "@/types";

export function ConnectionStatus({
  signaling,
  participants,
  peerStates,
}: {
  signaling: string;
  participants: Participant[];
  peerStates: Record<number, string>;
}) {
  const connected = participants.filter(
    (participant) => peerStates[participant.id] === "connected",
  ).length;
  const states = participants.map((participant) => peerStates[participant.id]);
  const state =
    signaling !== "connected"
      ? "unavailable"
      : !participants.length
        ? "waiting"
        : states.includes("failed")
          ? "failed"
          : states.includes("disconnected")
            ? "interrupted"
            : connected === participants.length
              ? "connected"
              : "connecting";
  const label = {
    unavailable: "Media: Unavailable",
    waiting: "Waiting for participants",
    failed: "Media: Failed",
    interrupted: "Media: Interrupted",
    connected: `Media: Connected (${connected}/${participants.length})`,
    connecting: `Media: Connecting (${connected}/${participants.length})`,
  }[state];
  return (
    <div className="connection-status" role="status" aria-live="polite">
      <span
        className={`room-connection ${signaling !== "connected" ? "room-offline" : ""}`}
      >
        <Signal size={14} />
        Signaling:{" "}
        {signaling === "connected"
          ? "Connected"
          : signaling === "disconnected"
            ? "Disconnected"
            : "Connecting"}
      </span>
      <span
        className={`media-connection media-${state}`}
        data-state={state}
        title="Peer media transport. Camera and microphone may be off; check the tiles for playback."
      >
        <Link2 size={14} />
        {label}
      </span>
    </div>
  );
}
