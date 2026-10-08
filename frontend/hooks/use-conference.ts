"use client";

import { useEffect, useRef, useState } from "react";
import { api, websocketUrl } from "@/lib/api";
import { errorMessage } from "@/lib/meetings";
import type { Admission, Participant } from "@/types";

interface Peer {
  pc: RTCPeerConnection;
  candidates: RTCIceCandidateInit[];
  stream: MediaStream;
}
interface SignalMessage {
  type: string;
  self_id?: number;
  participants?: Participant[];
  participant?: Participant;
  id?: number;
  sender?: number;
  payload?: RTCSessionDescriptionInit & RTCIceCandidateInit;
  message?: string;
}

export function useConference(
  code: string,
  admission: Admission | null,
  stream: MediaStream | null,
  audioEnabled: boolean,
  videoEnabled: boolean,
  onMute: () => void,
  notify: (message: string) => void,
) {
  const socketRef = useRef<WebSocket | null>(null);
  const peers = useRef(new Map<number, Peer>());
  const mediaRef = useRef({ stream, audioEnabled, videoEnabled });
  const muteRef = useRef(onMute);
  const notifyRef = useRef(notify);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [remoteStreams, setRemoteStreams] = useState<
    Record<number, MediaStream>
  >({});
  const [peerStates, setPeerStates] = useState<Record<number, string>>({});
  const [connection, setConnection] = useState("connecting");
  const [terminal, setTerminal] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    muteRef.current = onMute;
    notifyRef.current = notify;
  }, [onMute, notify]);
  useEffect(() => {
    mediaRef.current = { stream, audioEnabled, videoEnabled };
    for (const { pc } of peers.current.values()) {
      for (const kind of ["audio", "video"]) {
        const sender = pc
          .getTransceivers()
          .find(
            (transceiver) => transceiver.receiver.track.kind === kind,
          )?.sender;
        const track =
          stream?.getTracks().find((track) => track.kind === kind) ?? null;
        if (sender && sender.track !== track)
          void sender.replaceTrack(track).catch(() => {});
      }
    }
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({
          type: "media-state",
          audio_enabled: audioEnabled,
          video_enabled: videoEnabled,
        }),
      );
  }, [stream, audioEnabled, videoEnabled]);

  useEffect(() => {
    if (!admission) return;
    let cancelled = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const peerMap = peers.current;
    const localId = admission.participant.id;
    const send = (message: object) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(message));
    };
    const drop = (id: number) => {
      peerMap.get(id)?.pc.close();
      peerMap.delete(id);
      setRemoteStreams((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setPeerStates((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    };

    async function connect() {
      try {
        const config = await api.rtc();
        if (cancelled) return;
        const socket = new WebSocket(websocketUrl(code));
        socketRef.current = socket;
        const ensurePeer = (id: number): Peer => {
          const existing = peerMap.get(id);
          if (existing) return existing;
          const pc = new RTCPeerConnection({ iceServers: config.ice_servers });
          const peer: Peer = { pc, candidates: [], stream: new MediaStream() };
          peerMap.set(id, peer);
          // The offerer creates m-lines. The answerer uses the transceivers from
          // the remote offer; precreating its own can produce one-way media.
          if (localId < id)
            for (const kind of ["audio", "video"] as const) {
              const track = mediaRef.current.stream
                ?.getTracks()
                .find((track) => track.kind === kind);
              pc.addTransceiver(track ?? kind, {
                direction: "sendrecv",
                streams: mediaRef.current.stream
                  ? [mediaRef.current.stream]
                  : [],
              });
            }
          pc.onicecandidate = (event) => {
            if (event.candidate)
              send({
                type: "candidate",
                target: id,
                payload: event.candidate.toJSON(),
              });
          };
          pc.ontrack = (event) => {
            if (cancelled) return;
            if (
              !peer.stream
                .getTracks()
                .some((track) => track.id === event.track.id)
            )
              peer.stream.addTrack(event.track);
            setRemoteStreams((current) => ({ ...current, [id]: peer.stream }));
          };
          pc.onconnectionstatechange = () => {
            if (!cancelled) {
              setPeerStates((current) => ({
                ...current,
                [id]: pc.connectionState,
              }));
              if (pc.connectionState === "failed")
                setError(
                  "The media connection failed. Try rejoining, or use another network. Some networks need a TURN relay.",
                );
            }
          };
          return peer;
        };
        async function offer(id: number) {
          if (id === localId) return;
          const peer = ensurePeer(id);
          // Exactly one side initiates each pair, avoiding simultaneous offers.
          if (localId < id && peer.pc.signalingState === "stable") {
            await peer.pc.setLocalDescription(await peer.pc.createOffer());
            send({
              type: "offer",
              target: id,
              payload: peer.pc.localDescription?.toJSON(),
            });
          }
        }
        socket.onopen = () => {
          socket.send(
            JSON.stringify({
              type: "auth",
              token: admission!.participant_token,
            }),
          );
          heartbeat = setInterval(() => send({ type: "ping" }), 20000);
        };
        socket.onmessage = async (event) => {
          try {
            const message: SignalMessage = JSON.parse(event.data);
            if (cancelled) return;
            if (message.type === "welcome") {
              setConnection("connected");
              setParticipants(message.participants ?? []);
              setError("");
              send({
                type: "media-state",
                audio_enabled: mediaRef.current.audioEnabled,
                video_enabled: mediaRef.current.videoEnabled,
              });
              for (const participant of message.participants ?? [])
                await offer(participant.id);
            } else if (
              message.type === "participant-joined" &&
              message.participant
            ) {
              const participant = message.participant;
              setParticipants((current) => [
                ...current.filter((item) => item.id !== participant.id),
                participant,
              ]);
              notifyRef.current(
                `${participant.display_name} joined the meeting`,
              );
              await offer(participant.id);
            } else if (message.type === "participant-left" && message.id) {
              drop(message.id);
              setParticipants((current) =>
                current.filter((item) => item.id !== message.id),
              );
            } else if (message.type === "media-state" && message.participant) {
              const participant = message.participant;
              setParticipants((current) =>
                current.map((item) =>
                  item.id === participant.id ? participant : item,
                ),
              );
            } else if (
              ["offer", "answer", "candidate"].includes(message.type) &&
              message.sender &&
              message.payload
            ) {
              const peer = ensurePeer(message.sender);
              if (message.type === "candidate") {
                if (peer.pc.remoteDescription)
                  await peer.pc.addIceCandidate(message.payload);
                else peer.candidates.push(message.payload);
              } else {
                await peer.pc.setRemoteDescription(message.payload);
                for (const candidate of peer.candidates.splice(0))
                  await peer.pc.addIceCandidate(candidate);
                if (message.type === "offer") {
                  for (const transceiver of peer.pc.getTransceivers()) {
                    const track =
                      mediaRef.current.stream
                        ?.getTracks()
                        .find(
                          (track) =>
                            track.kind === transceiver.receiver.track.kind,
                        ) ?? null;
                    await transceiver.sender.replaceTrack(track);
                    if (mediaRef.current.stream)
                      transceiver.sender.setStreams(mediaRef.current.stream);
                    transceiver.direction = "sendrecv";
                  }
                  await peer.pc.setLocalDescription(
                    await peer.pc.createAnswer(),
                  );
                  send({
                    type: "answer",
                    target: message.sender,
                    payload: peer.pc.localDescription?.toJSON(),
                  });
                }
              }
            } else if (message.type === "mute-request") {
              muteRef.current();
              notifyRef.current(
                "The host muted your microphone. You can unmute when you're ready.",
              );
            } else if (
              message.type === "meeting-ended" ||
              message.type === "removed"
            ) {
              setTerminal(
                message.type === "removed"
                  ? "The host removed you from this meeting."
                  : "This meeting has ended.",
              );
              setConnection("ended");
              socket.close();
              peerMap.forEach((peer) => peer.pc.close());
              peerMap.clear();
            } else if (message.type === "notice")
              notifyRef.current(message.message ?? "Done");
            else if (message.type === "error")
              setError(
                message.message ?? "The meeting server reported an error.",
              );
          } catch (error) {
            if (!cancelled)
              setError(
                `We couldn't establish a media connection. ${errorMessage(error)}`,
              );
          }
        };
        socket.onerror = () => {
          if (!cancelled)
            setError("The connection to the meeting server was interrupted.");
        };
        socket.onclose = () => {
          clearInterval(heartbeat);
          if (!cancelled) {
            setConnection((current) =>
              current === "ended" ? current : "disconnected",
            );
            setError("The meeting connection closed. Rejoin to connect again.");
            peerMap.forEach((peer) => peer.pc.close());
            peerMap.clear();
          }
        };
      } catch (error) {
        if (!cancelled) {
          setError(errorMessage(error));
          setConnection("disconnected");
        }
      }
    }
    void connect();
    return () => {
      cancelled = true;
      clearInterval(heartbeat);
      socketRef.current?.close();
      socketRef.current = null;
      peerMap.forEach((peer) => peer.pc.close());
      peerMap.clear();
    };
  }, [admission, code]);

  function command(type: "mute-all" | "remove-participant", target?: number) {
    if (socketRef.current?.readyState === WebSocket.OPEN)
      socketRef.current.send(JSON.stringify({ type, target }));
  }
  return {
    participants,
    remoteStreams,
    peerStates,
    connection,
    terminal,
    error,
    command,
  };
}
