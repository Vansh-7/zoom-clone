function candidateType(candidate: string): string {
  return candidate.match(/\btyp (host|srflx|prflx|relay)\b/)?.[1] ?? "unknown";
}

// Reports deliberately exclude SDP, candidate addresses, tokens, and TURN credentials.
export function rtcDiagnostics(pc: RTCPeerConnection, turnConfigured: boolean) {
  const local: Record<string, number> = {};
  const remote: Record<string, number> = {};
  const remoteSeen = new Set<string>();
  const serverErrors: { code: number; server: string }[] = [];
  const signalingErrors: string[] = [];
  let remoteGatheringComplete = false;
  const log = (event: string, extra = {}) =>
    console.info("[WebRTC]", {
      event,
      connection: pc.connectionState,
      ice: pc.iceConnectionState,
      gathering: pc.iceGatheringState,
      signaling: pc.signalingState,
      ...extra,
    });
  pc.addEventListener("icecandidate", ({ candidate }) => {
    if (candidate) {
      const type = candidate.type ?? candidateType(candidate.candidate);
      local[type] = (local[type] ?? 0) + 1;
    }
  });
  pc.addEventListener("icecandidateerror", (event) => {
    const error = { code: event.errorCode, server: event.url.split(":")[0] };
    if (
      !serverErrors.some(
        (item) => item.code === error.code && item.server === error.server,
      )
    )
      serverErrors.push(error);
    log("ice-server-error", error);
  });
  for (const event of [
    "connectionstatechange",
    "iceconnectionstatechange",
    "icegatheringstatechange",
    "signalingstatechange",
  ])
    pc.addEventListener(event, () => log(event));

  return {
    remoteCandidate(candidate: RTCIceCandidateInit) {
      if (!candidate.candidate) remoteGatheringComplete = true;
      else if (!remoteSeen.has(candidate.candidate)) {
        remoteSeen.add(candidate.candidate);
        const type = candidateType(candidate.candidate);
        remote[type] = (remote[type] ?? 0) + 1;
      }
    },
    signalingError(error: unknown) {
      const name = error instanceof Error ? error.name : "UnknownError";
      signalingErrors.push(name);
      log("signaling-error", { name });
    },
    async snapshot() {
      const stats = await pc.getStats().catch(() => new Map());
      let pair;
      const receivedPackets = { audio: 0, video: 0 };
      for (const report of stats.values()) {
        if (report.type === "transport" && report.selectedCandidatePairId)
          pair = stats.get(report.selectedCandidatePairId);
        if (report.type === "inbound-rtp" && report.kind === "audio")
          receivedPackets.audio += report.packetsReceived ?? 0;
        if (report.type === "inbound-rtp" && report.kind === "video")
          receivedPackets.video += report.packetsReceived ?? 0;
      }
      const localCandidate = pair && stats.get(pair.localCandidateId);
      const remoteCandidate = pair && stats.get(pair.remoteCandidateId);
      return {
        connection: pc.connectionState,
        ice: pc.iceConnectionState,
        gathering: pc.iceGatheringState,
        signaling: pc.signalingState,
        localDescription: pc.localDescription?.type ?? null,
        remoteDescription: pc.remoteDescription?.type ?? null,
        localCandidates: { ...local },
        remoteCandidates: { ...remote },
        remoteGatheringComplete,
        turnConfigured,
        receivedPackets,
        policy: pc.getConfiguration().iceTransportPolicy ?? "all",
        selectedPair: pair
          ? {
              state: pair.state,
              localType: localCandidate?.candidateType,
              remoteType: remoteCandidate?.candidateType,
              protocol: localCandidate?.protocol,
              relayProtocol: localCandidate?.relayProtocol,
            }
          : null,
        serverErrors: [...serverErrors],
        signalingErrors: [...signalingErrors],
      };
    },
  };
}

export type RtcDiagnosticReport = Awaited<
  ReturnType<ReturnType<typeof rtcDiagnostics>["snapshot"]>
>;

export function mediaFailure(report: RtcDiagnosticReport) {
  if (
    !report.localDescription ||
    !report.remoteDescription ||
    report.signaling !== "stable"
  )
    return "Media negotiation did not complete. Copy connection diagnostics and rejoin the meeting.";
  if (["connected", "completed"].includes(report.ice))
    return "The network path connected, but secure media transport failed. Copy connection diagnostics and rejoin.";
  if (Object.keys(report.localCandidates).length === 0)
    return report.policy === "relay"
      ? "No TURN relay candidates were gathered. Check the relay hostname, transport, credentials, and network reachability."
      : "No local ICE candidates were gathered. Check browser/network permissions and ICE server reachability.";
  if (Object.keys(report.remoteCandidates).length === 0)
    return "No usable remote ICE candidates were gathered or received. Copy connection diagnostics and retry the media connection.";
  return (
    "ICE could not establish a media path between participants. " +
    (report.turnConfigured
      ? "Check the TURN service, credentials, and network firewall."
      : "No TURN relay is configured; Wi-Fi isolation, NAT, or firewall rules can block direct media.")
  );
}
