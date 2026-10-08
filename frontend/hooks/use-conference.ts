"use client";

import { useEffect, useRef, useState } from "react";
import { api, websocketUrl } from "@/lib/api";
import { errorMessage } from "@/lib/meetings";
import { mediaFailure, rtcDiagnostics } from "@/lib/rtc-diagnostics";
import type { Admission, Participant } from "@/types";

interface Peer {
  pc: RTCPeerConnection;
  candidates: RTCIceCandidateInit[];
  stream: MediaStream;
  makingOffer: boolean;
  diagnostics: ReturnType<typeof rtcDiagnostics>;
  timeout?: ReturnType<typeof setTimeout>;
}

function closePeer(peer: Peer) {
  clearTimeout(peer.timeout);
  peer.pc.close();
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

function candidateMatches(
  pc: RTCPeerConnection,
  candidate: RTCIceCandidateInit,
) {
  return (
    !!pc.remoteDescription &&
    (!candidate.usernameFragment ||
      pc.remoteDescription.sdp
        ?.split(/\r?\n/)
        .includes(`a=ice-ufrag:${candidate.usernameFragment}`))
  );
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
  const retryRef = useRef<(() => Promise<void>) | null>(null);
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
          void sender.replaceTrack(track).catch((error) => {
            if (pc.connectionState !== "closed")
              setError(
                `We couldn't update your ${kind} track. ${errorMessage(error)}`,
              );
          });
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
      const peer = peerMap.get(id);
      if (peer) closePeer(peer);
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
        const watchAttempt = (peer: Peer) => {
          clearTimeout(peer.timeout);
          peer.timeout = setTimeout(() => {
            void peer.diagnostics.snapshot().then((report) => {
              if (
                !cancelled &&
                !["connected", "closed"].includes(peer.pc.connectionState)
              )
                setError(
                  `Media setup is taking too long. ${mediaFailure(report)}`,
                );
            });
          }, 25000);
        };
        const ensurePeer = (id: number): Peer => {
          const existing = peerMap.get(id);
          if (existing) return existing;
          const pc = new RTCPeerConnection({
            iceServers: config.ice_servers,
            iceTransportPolicy: config.ice_transport_policy ?? "all",
          });
          const turnConfigured = config.ice_servers.some((server) =>
            (Array.isArray(server.urls) ? server.urls : [server.urls]).some(
              (url) => /^turns?:/.test(url),
            ),
          );
          const peer: Peer = {
            pc,
            candidates: [],
            stream: new MediaStream(),
            makingOffer: false,
            diagnostics: rtcDiagnostics(pc, turnConfigured),
          };
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
            if (!cancelled && peerMap.get(id) === peer)
              send({
                type: "candidate",
                target: id,
                payload: event.candidate?.toJSON() ?? {
                  candidate: "",
                  usernameFragment: pc.localDescription?.sdp
                    ?.match(/^a=ice-ufrag:(.+)$/m)?.[1]
                    .trim(),
                },
              });
          };
          pc.ontrack = (event) => {
            if (cancelled || peerMap.get(id) !== peer) return;
            if (
              !peer.stream
                .getTracks()
                .some((track) => track.id === event.track.id)
            )
              peer.stream.addTrack(event.track);
            setRemoteStreams((current) => ({ ...current, [id]: peer.stream }));
          };
          pc.onconnectionstatechange = () => {
            if (!cancelled && peerMap.get(id) === peer) {
              setPeerStates((current) => ({
                ...current,
                [id]: pc.connectionState,
              }));
              if (pc.connectionState === "failed") {
                clearTimeout(peer.timeout);
                void peer.diagnostics.snapshot().then((report) => {
                  if (!cancelled && pc.connectionState === "failed")
                    setError(mediaFailure(report));
                });
              } else if (pc.connectionState === "connected") {
                clearTimeout(peer.timeout);
                setError("");
              }
            }
          };
          watchAttempt(peer);
          return peer;
        };
        async function offer(id: number, restart = false) {
          if (cancelled || id === localId) return;
          const peer = ensurePeer(id);
          // Exactly one side initiates each pair, avoiding simultaneous offers.
          if (
            localId < id &&
            !peer.makingOffer &&
            peer.pc.signalingState === "stable"
          ) {
            peer.makingOffer = true;
            try {
              if (restart) watchAttempt(peer);
              const description = await peer.pc.createOffer({
                iceRestart: restart,
              });
              if (cancelled || peerMap.get(id) !== peer) return;
              await peer.pc.setLocalDescription(description);
              send({
                type: "offer",
                target: id,
                payload: peer.pc.localDescription?.toJSON(),
              });
            } finally {
              peer.makingOffer = false;
            }
          }
        }
        retryRef.current = async () => {
          for (const id of peerMap.keys()) {
            if (localId < id) await offer(id, true);
            else send({ type: "restart-ice", target: id });
          }
        };
        socket.onopen = () => {
          socket.send(
            JSON.stringify({
              type: "auth",
              token: admission!.participant_token,
            }),
          );
          heartbeat = setInterval(() => send({ type: "ping" }), 20000);
        };
        let messages = Promise.resolve();
        socket.onmessage = (event) => {
          // WebSocket order alone does not serialize async offer/answer handlers.
          messages = messages.then(async () => {
            let signalPeer: Peer | undefined;
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
              } else if (
                message.type === "media-state" &&
                message.participant
              ) {
                const participant = message.participant;
                setParticipants((current) =>
                  current.map((item) =>
                    item.id === participant.id ? participant : item,
                  ),
                );
              } else if (message.type === "restart-ice" && message.sender) {
                await offer(message.sender, true);
              } else if (
                ["offer", "answer", "candidate"].includes(message.type) &&
                message.sender &&
                message.payload
              ) {
                const peer = ensurePeer(message.sender);
                signalPeer = peer;
                if (message.type === "candidate") {
                  peer.diagnostics.remoteCandidate(message.payload);
                  if (candidateMatches(peer.pc, message.payload))
                    await peer.pc.addIceCandidate(message.payload);
                  else if (peer.candidates.length < 128)
                    peer.candidates.push(message.payload);
                  else throw new Error("Too many queued ICE candidates");
                } else {
                  if (message.type === "offer") watchAttempt(peer);
                  await peer.pc.setRemoteDescription(message.payload);
                  for (const candidate of message.payload.sdp?.match(
                    /^a=candidate:.*$/gm,
                  ) ?? [])
                    peer.diagnostics.remoteCandidate({
                      candidate: candidate.slice(2),
                    });
                  for (const candidate of peer.candidates.splice(0)) {
                    if (candidateMatches(peer.pc, candidate))
                      await peer.pc.addIceCandidate(candidate);
                    else peer.candidates.push(candidate);
                  }
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
                peerMap.forEach(closePeer);
                peerMap.clear();
              } else if (message.type === "notice")
                notifyRef.current(message.message ?? "Done");
              else if (message.type === "error")
                setError(
                  message.message ?? "The meeting server reported an error.",
                );
            } catch (error) {
              signalPeer?.diagnostics.signalingError(error);
              if (!cancelled)
                setError(
                  `We couldn't establish a media connection. ${errorMessage(error)}`,
                );
            }
          });
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
            peerMap.forEach(closePeer);
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
      retryRef.current = null;
      clearInterval(heartbeat);
      socketRef.current?.close();
      socketRef.current = null;
      peerMap.forEach(closePeer);
      peerMap.clear();
    };
  }, [admission, code]);

  function command(type: "mute-all" | "remove-participant", target?: number) {
    if (socketRef.current?.readyState === WebSocket.OPEN)
      socketRef.current.send(JSON.stringify({ type, target }));
  }
  function retryMedia() {
    setError("");
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setError("Signaling is disconnected. Rejoin the meeting to reconnect.");
      return;
    }
    void retryRef.current?.().catch((error) => setError(errorMessage(error)));
  }
  async function diagnostics() {
    return JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        signaling: socketRef.current?.readyState ?? WebSocket.CLOSED,
        peers: await Promise.all(
          Array.from(peers.current.values(), (peer) =>
            peer.diagnostics.snapshot(),
          ),
        ),
      },
      null,
      2,
    );
  }
  return {
    participants,
    remoteStreams,
    peerStates,
    connection,
    terminal,
    error,
    command,
    retryMedia,
    diagnostics,
  };
}
