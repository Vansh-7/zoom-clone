"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  Grid2X2,
  Heart,
  Hand,
  MoreHorizontal,
  Expand,
  Info,
  Link2,
  LockKeyhole,
  Mic,
  MicOff,
  MonitorUp,
  MessageSquare,
  OctagonX,
  ShieldCheck,
  Users,
  Video,
  VideoOff,
  X,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import {
  copyText,
  errorMessage,
  formatCode,
  hostToken,
  initials,
} from "@/lib/meetings";
import { useLocalMedia } from "@/hooks/use-local-media";
import { useConference } from "@/hooks/use-conference";
import { useScreenShare } from "@/hooks/use-screen-share";
import type { Admission, Meeting, Participant, Reaction } from "@/types";
import { reactions } from "@/lib/reactions";
import { RoomPopover } from "./room-popover";
import { MeetingDetails } from "./meeting-dialogs";
import { MeetingChat } from "./meeting-chat";
import { ConnectionStatus } from "./connection-status";
import { RemoteAudio } from "./remote-audio";
import { DeviceSelectors } from "./device-selectors";
import { WorkspaceShell } from "./workspace-shell";
import { WorkplaceBrand } from "./workplace-brand";
import { ErrorNotice, Modal, Spinner, useToast } from "./ui";

function VideoTile({
  stream,
  participant,
  local = false,
  screen = false,
  videoEnabled,
  connectionState,
  reaction,
  onSelect,
}: {
  stream?: MediaStream | null;
  participant: Participant;
  local?: boolean;
  screen?: boolean;
  videoEnabled: boolean;
  connectionState?: string;
  reaction?: Reaction;
  onSelect?: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let active = true;
    element.srcObject = stream ?? null;
    if (stream)
      void element.play().then(
        () => {
          if (active) setAutoplayBlocked(false);
        },
        (error: DOMException) => {
          if (active && error.name === "NotAllowedError")
            setAutoplayBlocked(true);
        },
      );
    return () => {
      active = false;
      element.srcObject = null;
    };
  }, [stream]);
  return (
    <div
      className={`video-tile ${local ? "local-tile" : ""} ${screen ? "screen-tile" : "camera-tile"}`}
      data-participant-id={participant.id}
    >
      <video
        ref={video}
        autoPlay
        playsInline
        muted
        className={`${local && !screen ? "mirrored" : ""} ${videoEnabled && stream ? "" : "video-hidden"}`}
        aria-label={`${participant.display_name}${local ? " (you)" : ""} ${screen ? "screen" : "video"}`}
      />
      {(!videoEnabled || !stream) && (
        <div className="tile-placeholder">
          <div className="tile-avatar">
            {initials(participant.display_name || "You")}
          </div>
          <span>{participant.display_name || "Your camera is off"}</span>
        </div>
      )}
      {connectionState &&
        !["connected", "closed"].includes(connectionState) && (
          <span className="tile-connection">
            <Spinner size={13} />
            {connectionState === "failed" ? "Connection failed" : "Connecting…"}
          </span>
        )}
      <div className="tile-name">
        {participant.audio_enabled ? <Mic size={13} /> : <MicOff size={13} />}
        <span>
          {participant.display_name || "You"}
          {local ? " (You)" : ""}
        </span>
        {participant.role === "host" && <span className="tile-host">Host</span>}
        {screen && <span className="tile-sharing">Sharing screen</span>}
      </div>
      {autoplayBlocked && (
        <button
          className="play-video"
          onClick={() => {
            void video.current
              ?.play()
              .then(() => setAutoplayBlocked(false))
              .catch(() => setAutoplayBlocked(true));
          }}
        >
          Play video
        </button>
      )}
      {onSelect && (
        <button
          className="select-speaker"
          onClick={onSelect}
          aria-label={`Spotlight ${participant.display_name}`}
        />
      )}
      {reaction && !screen && (
        <span
          className="tile-reaction"
          role="img"
          aria-label={`${participant.display_name}: ${reactions.find((item) => item.type === reaction)?.label}`}
          key={reaction}
        >
          {reactions.find((item) => item.type === reaction)?.emoji}
        </span>
      )}
      {participant.hand_raised && !screen && (
        <span
          className="tile-hand"
          role="img"
          aria-label={`${participant.display_name} raised hand`}
        >
          ✋
        </span>
      )}
    </div>
  );
}

export function MeetingRoom({ code }: { code: string }) {
  const router = useRouter();
  const notify = useToast();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [ownerToken, setOwnerToken] = useState<string | undefined>();
  const [admission, setAdmission] = useState<Admission | null>(null);
  const [joining, setJoining] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [navigationTarget, setNavigationTarget] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Participant | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [duration, setDuration] = useState(0);
  const [popover, setPopover] = useState<
    "info" | "view" | "reactions" | "more" | null
  >(null);
  const [view, setView] = useState<"gallery" | "speaker">("gallery");
  const [hideSelf, setHideSelf] = useState(false);
  const [speakerId, setSpeakerId] = useState<number | null>(null);
  const [hostToolsOpen, setHostToolsOpen] = useState(false);
  const lastReaction = useRef(0);
  const closePopover = useCallback(() => setPopover(null), []);
  function fullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else
      void document.documentElement
        .requestFullscreen()
        .catch(() => notify("Full screen isn't available in this browser."));
  }
  const media = useLocalMedia();
  const screen = useScreenShare();
  const conference = useConference(
    code,
    admission,
    media.stream,
    media.audioEnabled,
    media.videoEnabled,
    media.muteAudio,
    notify,
    screen.stream,
  );

  const load = useCallback(async () => {
    try {
      setMeeting(await api.meeting(code));
      setOwnerToken(hostToken(code));
      setName(sessionStorage.getItem(`zoom:name:${code}`) ?? "");
      setError("");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [code]);
  // The public invite route must validate its meeting against the backend on entry.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  useEffect(() => {
    if (!admission) return;
    const started = Date.now();
    const timer = setInterval(
      () => setDuration(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [admission]);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void api
        .meeting(code)
        .then((result) => {
          setMeeting(result);
          if (result.status !== "scheduled") setWaiting(false);
        })
        .catch((error) => setError(errorMessage(error)));
    }, 3000);
    return () => clearInterval(timer);
  }, [waiting, code]);
  const stopMedia = media.stop;
  const stopScreen = screen.stop;
  useEffect(() => {
    if (conference.terminal) {
      stopScreen();
      stopMedia();
    }
  }, [conference.terminal, stopMedia, stopScreen]);

  async function join(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setJoining(true);
    setError("");
    try {
      if (meeting?.status === "scheduled" && ownerToken)
        setMeeting(await api.start(code, ownerToken));
      const result = await api.join(code, name.trim(), ownerToken);
      sessionStorage.setItem(`zoom:name:${code}`, name.trim());
      setAdmission(result);
      setWaiting(false);
    } catch (error) {
      if (error instanceof ApiError && error.code === "HOST_NOT_STARTED")
        setWaiting(true);
      else setError(errorMessage(error));
    } finally {
      setJoining(false);
    }
  }
  async function copy() {
    try {
      await copyText(meeting?.invite_url ?? "");
      notify("Invitation link copied to clipboard");
    } catch (error) {
      notify(errorMessage(error));
      setDetailsOpen(true);
    }
  }
  async function leave(endForAll = false, destination = "/") {
    setLeaving(true);
    try {
      if (endForAll && ownerToken) await api.end(code, ownerToken);
      else if (admission) await api.leave(code, admission.participant_token);
      media.stop();
      screen.stop();
      router.push(destination);
    } catch (error) {
      setError(errorMessage(error));
      setLeaving(false);
      setConfirmEnd(false);
    }
  }

  const isHost = admission?.participant.role === "host";
  const finished =
    conference.terminal ||
    (meeting && ["ended", "missed"].includes(meeting.status)
      ? "This meeting has ended."
      : "");
  if (finished)
    return (
      <main className="exit-screen">
        <Link className="wordmark" href="/">
          <WorkplaceBrand />
        </Link>
        <div className="exit-icon">
          <Check size={34} />
        </div>
        <h1>{finished}</h1>
        <p>
          {conference.terminal.includes("removed")
            ? "Contact the host if you think this was a mistake."
            : "Thanks for connecting. We’ll see you at the next one."}
        </p>
        <Link className="button primary" href="/">
          Back to Home
        </Link>
      </main>
    );

  if (!admission)
    return (
      <div className="prejoin-page">
        <header className="prejoin-header">
          <Link className="wordmark" href="/">
            <WorkplaceBrand />
          </Link>
          <Link href="/" className="back-link">
            <ArrowLeft size={16} />
            Back to Home
          </Link>
        </header>
        {loading ? (
          <main className="prejoin-loading">
            <Spinner size={30} />
            <p>Getting your meeting ready…</p>
          </main>
        ) : !meeting ? (
          <main className="standalone">
            <h1>We couldn’t find your meeting.</h1>
            <ErrorNotice message={error} onRetry={() => void load()} />
            <Link className="button primary" href="/">
              Back to Home
            </Link>
          </main>
        ) : (
          <main className="prejoin-main">
            <div className="prejoin-heading">
              <span className="prejoin-eyebrow">
                <ShieldCheck size={15} />
                {ownerToken ? "YOU’RE THE HOST" : "YOU’RE INVITED"}
              </span>
              <h1>{meeting.title}</h1>
              <p>Check your audio and video before you join.</p>
            </div>
            <div className="prejoin-grid">
              <div className="preview-column">
                <div className="preview-frame">
                  <VideoTile
                    stream={media.stream}
                    local
                    participant={{
                      id: 0,
                      display_name: name || "You",
                      role: ownerToken ? "host" : "guest",
                      audio_enabled: media.audioEnabled,
                    }}
                    videoEnabled={media.videoEnabled}
                  />
                  {!media.stream && (
                    <div className="preview-enable">
                      <button
                        className="button preview-enable-button"
                        disabled={media.pending}
                        onClick={() => void media.enableBoth()}
                      >
                        {media.pending ? <Spinner /> : <Video size={18} />}
                        Enable camera & microphone
                      </button>
                      <span>You can also join with both turned off.</span>
                    </div>
                  )}
                </div>
                <div className="preview-controls">
                  <button
                    className={media.audioEnabled ? "" : "control-off"}
                    aria-label={
                      media.audioEnabled
                        ? "Mute microphone"
                        : "Enable microphone"
                    }
                    onClick={() => void media.toggleAudio()}
                    disabled={media.pending}
                  >
                    {media.audioEnabled ? (
                      <Mic size={21} />
                    ) : (
                      <MicOff size={21} />
                    )}
                  </button>
                  <button
                    className={media.videoEnabled ? "" : "control-off"}
                    aria-label={
                      media.videoEnabled ? "Turn camera off" : "Enable camera"
                    }
                    onClick={() => void media.toggleVideo()}
                    disabled={media.pending}
                  >
                    {media.videoEnabled ? (
                      <Video size={21} />
                    ) : (
                      <VideoOff size={21} />
                    )}
                  </button>
                  <span>
                    {media.pending
                      ? "Connecting your devices…"
                      : media.audioEnabled || media.videoEnabled
                        ? "Looking good. You're ready to join."
                        : "Your microphone and camera are off"}
                  </span>
                </div>
                <DeviceSelectors
                  devices={media.devices}
                  selected={media.deviceIds}
                  pending={media.pending}
                  onSelect={media.selectDevice}
                />
                {Object.values(media.issues).map((issue) => (
                  <p className="media-warning" role="status" key={issue}>
                    {issue}
                  </p>
                ))}
              </div>
              <form className="prejoin-form" onSubmit={join}>
                <div className="prejoin-meeting-info">
                  <Video size={22} />
                  <div>
                    <strong>
                      {ownerToken
                        ? "Start a conversation"
                        : "Join the conversation"}
                    </strong>
                    <span>Meeting ID: {formatCode(code)}</span>
                  </div>
                </div>
                <label>
                  Your name
                  <input
                    required
                    autoFocus
                    maxLength={80}
                    autoComplete="name"
                    placeholder="Enter your display name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <p className="name-note">
                  This is how you’ll appear to others in the meeting.
                </p>
                {waiting && (
                  <div className="waiting-notice" role="status">
                    <Spinner size={17} />
                    <span>
                      Waiting for the host to start. This page checks
                      automatically; select Join when the room is ready.
                    </span>
                  </div>
                )}
                {error && <ErrorNotice message={error} />}
                <button
                  className="button primary join-room-button"
                  disabled={joining || !name.trim() || media.pending}
                >
                  {joining ? <Spinner /> : <Video size={18} />}
                  {ownerToken ? "Start Meeting" : "Join Meeting"}
                </button>
                <button
                  type="button"
                  className="text-button prejoin-copy"
                  onClick={() => void copy()}
                >
                  <Link2 size={15} />
                  Copy invitation link
                </button>
                <div className="prejoin-security">
                  <LockKeyhole size={14} />
                  <span>
                    Your media connects directly between participants.
                  </span>
                </div>
              </form>
            </div>
          </main>
        )}
        {detailsOpen && meeting && (
          <MeetingDetails
            meeting={meeting}
            onClose={() => setDetailsOpen(false)}
          />
        )}
      </div>
    );

  const self =
    conference.participants.find(
      (participant) => participant.id === admission.participant.id,
    ) ?? admission.participant;
  const others = conference.participants.filter(
    (participant) => participant.id !== admission.participant.id,
  );
  const visible = [self, ...others].filter(
    (participant) => !hideSelf || participant.id !== self.id,
  );
  const speaker =
    visible.find((participant) => participant.id === speakerId) ??
    visible.find((participant) => participant.id !== self.id) ??
    visible[0];
  const camera = (participant: Participant, selectable = false) => (
    <VideoTile
      key={participant.id}
      stream={
        participant.id === self.id
          ? media.stream
          : conference.remoteStreams[participant.id]
      }
      participant={
        participant.id === self.id
          ? { ...self, audio_enabled: media.audioEnabled }
          : participant
      }
      local={participant.id === self.id}
      videoEnabled={
        participant.id === self.id
          ? media.videoEnabled
          : !!participant.video_enabled
      }
      connectionState={
        participant.id === self.id
          ? undefined
          : (conference.peerStates[participant.id] ?? "connecting")
      }
      reaction={conference.reactions[participant.id]}
      onSelect={selectable ? () => setSpeakerId(participant.id) : undefined}
    />
  );
  const cameras = visible.map((participant) => camera(participant));
  const presenters = others.filter((participant) => participant.screen_sharing);
  const presenting = screen.sharing || presenters.length > 0;
  return (
    <WorkspaceShell
      meeting
      offline={conference.connection === "disconnected"}
      loading={conference.connection === "connecting"}
      onNavigate={(href) => {
        setNavigationTarget(href);
        setConfirmEnd(true);
      }}
    >
      <div className="meeting-room">
        <header className="room-header">
          <div className="room-topic">
            <ShieldCheck size={17} />
            <RoomPopover
              placement="below"
              open={popover === "info"}
              onClose={closePopover}
              label="Meeting information"
              trigger={
                <button
                  aria-label="Meeting information"
                  aria-expanded={popover === "info"}
                  onClick={() => setPopover(popover === "info" ? null : "info")}
                >
                  <span>{meeting?.title}</span>
                  <ChevronDown size={13} />
                </button>
              }
            >
              <h2>{meeting?.title}</h2>
              <dl className="room-info">
                <dt>Invite Link</dt>
                <dd>
                  <span title={meeting?.invite_url}>{meeting?.invite_url}</span>
                  <button
                    aria-label="Copy invitation URL"
                    title="Copy invitation URL"
                    onClick={() => void copy()}
                  >
                    <Copy size={17} />
                  </button>
                </dd>
                <dt>Meeting ID</dt>
                <dd>{formatCode(code)}</dd>
                <dt>Host</dt>
                <dd>{meeting?.host_name}</dd>
              </dl>
            </RoomPopover>
          </div>
          <div className="room-header-right">
            <ConnectionStatus
              signaling={conference.connection}
              participants={others}
              peerStates={conference.peerStates}
            />
            <span className="room-timer">
              {Math.floor(duration / 60)
                .toString()
                .padStart(2, "0")}
              :{(duration % 60).toString().padStart(2, "0")}
            </span>
            <RoomPopover
              placement="below"
              open={popover === "view"}
              onClose={closePopover}
              label="Meeting view"
              trigger={
                <button
                  className="room-view-button"
                  aria-label="Meeting view"
                  aria-expanded={popover === "view"}
                  onClick={() => setPopover(popover === "view" ? null : "view")}
                >
                  <Grid2X2 size={17} />
                  <span>View</span>
                </button>
              }
            >
              <button
                aria-pressed={view === "gallery"}
                onClick={() => {
                  setView("gallery");
                  closePopover();
                }}
              >
                <span>Gallery View</span>
                {view === "gallery" ? (
                  <Check size={16} />
                ) : (
                  <Grid2X2 size={16} />
                )}
              </button>
              <button
                aria-pressed={view === "speaker"}
                onClick={() => setView("speaker")}
              >
                <span>Speaker View</span>
                {view === "speaker" ? <Check size={16} /> : <Video size={16} />}
              </button>
              {view === "speaker" && (
                <label className="speaker-select">
                  Spotlight participant
                  <select
                    aria-label="Spotlight participant"
                    value={speaker?.id ?? ""}
                    onChange={(event) =>
                      setSpeakerId(Number(event.target.value))
                    }
                  >
                    {visible.map((participant) => (
                      <option key={participant.id} value={participant.id}>
                        {participant.display_name}
                      </option>
                    ))}
                  </select>
                  <span>Select a participant manually.</span>
                </label>
              )}
              <button
                className="popover-divider"
                aria-pressed={hideSelf}
                onClick={() => {
                  setHideSelf(!hideSelf);
                  closePopover();
                }}
              >
                {hideSelf ? "Show Self View" : "Hide Self View"}
              </button>
              <button
                onClick={() => {
                  fullscreen();
                  closePopover();
                }}
              >
                Fullscreen <Expand size={16} />
              </button>
            </RoomPopover>
            <button
              className="room-view-button"
              onClick={fullscreen}
              aria-label="Toggle full screen"
            >
              <Expand size={15} />
              <span>Full screen</span>
            </button>
          </div>
        </header>
        <div className="room-content">
          <main className="meeting-stage">
            <RemoteAudio streams={conference.remoteStreams} />
            {screen.sharing && (
              <div className="sharing-banner" role="status">
                <MonitorUp size={16} /> You are sharing your screen
                <button onClick={screen.stop}>Stop Share</button>
              </div>
            )}
            {conference.error || error ? (
              <div className="room-error" role="alert">
                <span>{conference.error || error}</span>
                {conference.error && conference.connection === "connected" && (
                  <button onClick={conference.retryMedia}>
                    Retry media connection
                  </button>
                )}
                {conference.error && (
                  <button
                    onClick={() =>
                      void conference
                        .diagnostics()
                        .then(copyText)
                        .then(() => notify("Connection diagnostics copied"))
                        .catch(() =>
                          notify(
                            "Clipboard access was blocked. Allow it and try again.",
                          ),
                        )
                    }
                  >
                    Copy connection diagnostics
                  </button>
                )}
                {conference.connection === "disconnected" && (
                  <button onClick={() => window.location.reload()}>
                    Rejoin meeting
                  </button>
                )}
              </div>
            ) : null}
            <div className="stage-media">
              {presenting ? (
                <div className="presentation-layout">
                  <div className="presentation-screens">
                    {screen.sharing && (
                      <VideoTile
                        stream={screen.stream}
                        participant={self}
                        local
                        screen
                        videoEnabled
                      />
                    )}
                    {presenters.map((participant) => (
                      <VideoTile
                        key={participant.id}
                        stream={conference.remoteScreenStreams[participant.id]}
                        participant={participant}
                        screen
                        videoEnabled
                        connectionState={
                          conference.peerStates[participant.id] ?? "connecting"
                        }
                      />
                    ))}
                  </div>
                  <div
                    className="camera-strip"
                    aria-label="Participant cameras"
                  >
                    {cameras}
                  </div>
                </div>
              ) : view === "speaker" && speaker ? (
                <div className="presentation-layout speaker-layout">
                  <div className="speaker-primary">{camera(speaker)}</div>
                  <div
                    className="camera-strip"
                    aria-label="Participant cameras"
                  >
                    {visible
                      .filter((participant) => participant.id !== speaker.id)
                      .map((participant) => camera(participant, true))}
                  </div>
                </div>
              ) : (
                <div
                  className={`video-grid ${visible.length <= 1 ? "video-grid-solo" : visible.length >= 3 ? "video-grid-gallery" : ""}`}
                >
                  {visible.length ? (
                    cameras
                  ) : (
                    <p className="self-hidden">
                      Your self view is hidden. Your camera settings are
                      unchanged.
                    </p>
                  )}
                </div>
              )}
            </div>
            {others.length === 0 && (
              <div className="alone-notice">
                <Users size={16} />
                <span>You’re the first one here.</span>
                <button onClick={() => void copy()}>
                  Invite others <Link2 size={13} />
                </button>
              </div>
            )}
            {Object.values(media.issues).length > 0 && (
              <div className="room-media-warning">
                {Object.values(media.issues).join(" ")}
              </div>
            )}
          </main>
          {rosterOpen && (
            <aside className="participants-panel" aria-label="Participants">
              <div className="participants-heading">
                <h2>Participants ({conference.participants.length || 1})</h2>
                <button
                  className="icon-button"
                  onClick={() => setRosterOpen(false)}
                  aria-label="Close participants"
                >
                  <X size={19} />
                </button>
              </div>
              <div className="participant-list">
                {(conference.participants.length
                  ? conference.participants
                  : [self]
                ).map((participant) => (
                  <div className="participant-row" key={participant.id}>
                    <span className="participant-avatar">
                      {initials(participant.display_name)}
                    </span>
                    <div>
                      <strong>
                        {participant.display_name}
                        {participant.id === self.id ? " (You)" : ""}
                      </strong>
                      {participant.role === "host" && <span>Host</span>}
                    </div>
                    <span className="participant-mic">
                      {participant.hand_raised && (
                        <span
                          role="img"
                          aria-label={`${participant.display_name} raised hand`}
                        >
                          ✋
                        </span>
                      )}
                      {participant.audio_enabled ? (
                        <Mic size={17} aria-label="Microphone on" />
                      ) : (
                        <MicOff
                          size={17}
                          className="media-off"
                          aria-label="Microphone off"
                        />
                      )}
                      {participant.video_enabled ? (
                        <Video size={17} aria-label="Camera on" />
                      ) : (
                        <VideoOff
                          size={17}
                          className="media-off"
                          aria-label="Camera off"
                        />
                      )}
                    </span>
                    {isHost && participant.id !== self.id && (
                      <button
                        className="remove-participant"
                        aria-label={`Remove ${participant.display_name}`}
                        title={`Remove ${participant.display_name}`}
                        disabled={conference.connection !== "connected"}
                        onClick={() => setRemoveTarget(participant)}
                      >
                        <OctagonX size={17} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="participants-footer">
                <button
                  className="button secondary"
                  onClick={() => void copy()}
                >
                  <Link2 size={15} />
                  Invite
                </button>
                {isHost && (
                  <button
                    className="button secondary"
                    onClick={() => conference.command("mute-all")}
                    disabled={conference.connection !== "connected"}
                  >
                    <MicOff size={15} />
                    Mute All
                  </button>
                )}
              </div>
            </aside>
          )}
          {hostToolsOpen && isHost && (
            <aside
              className="participants-panel host-panel"
              aria-label="Host tools"
            >
              <div className="participants-heading">
                <h2>Host tools</h2>
                <button
                  className="icon-button"
                  aria-label="Close host tools"
                  onClick={() => setHostToolsOpen(false)}
                >
                  <X size={19} />
                </button>
              </div>
              <div className="host-actions">
                <button
                  className="host-action"
                  disabled={conference.connection !== "connected"}
                  onClick={() => conference.command("mute-all")}
                >
                  <MicOff size={17} />
                  Mute All
                </button>
                <p>Participants can unmute themselves.</p>
                <h3>Manage participants</h3>
                {others.map((participant) => (
                  <div className="host-participant" key={participant.id}>
                    <span>{participant.display_name}</span>
                    <button
                      className="button secondary small"
                      onClick={() => setRemoveTarget(participant)}
                      aria-label={`Remove ${participant.display_name}`}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                {!others.length && <p>No other participants have joined.</p>}
                <button
                  className="host-action host-action-danger"
                  onClick={() => setConfirmEnd(true)}
                >
                  <OctagonX size={18} />
                  End Meeting for Everyone
                </button>
              </div>
            </aside>
          )}
          <MeetingChat
            open={chatOpen}
            messages={conference.chatMessages}
            participants={conference.participants}
            privateChatSupported={conference.privateChatSupported}
            connected={conference.connection === "connected"}
            selfId={self.id}
            send={conference.sendChat}
            onClose={() => setChatOpen(false)}
          />
        </div>
        <footer className="meeting-toolbar">
          <div className="toolbar-media">
            <button
              className={`toolbar-control ${media.audioEnabled ? "" : "toolbar-muted"}`}
              onClick={() => void media.toggleAudio()}
              disabled={media.pending}
              aria-label={
                media.audioEnabled ? "Mute microphone" : "Unmute microphone"
              }
            >
              {media.audioEnabled ? <Mic size={25} /> : <MicOff size={25} />}
              <span>{media.audioEnabled ? "Mute" : "Unmute"}</span>
            </button>
            <button
              className={`toolbar-control ${media.videoEnabled ? "" : "toolbar-muted"}`}
              onClick={() => void media.toggleVideo()}
              disabled={media.pending}
              aria-label={media.videoEnabled ? "Stop video" : "Start video"}
            >
              {media.videoEnabled ? (
                <Video size={25} />
              ) : (
                <VideoOff size={25} />
              )}
              <span>{media.videoEnabled ? "Stop Video" : "Start Video"}</span>
            </button>
          </div>
          <div className="toolbar-center">
            <button
              className={`toolbar-control ${rosterOpen ? "toolbar-active" : ""}`}
              aria-pressed={rosterOpen}
              onClick={() => {
                setRosterOpen(!rosterOpen);
                setChatOpen(false);
                setHostToolsOpen(false);
              }}
              aria-label="Show participants"
            >
              <span className="toolbar-count-icon">
                <Users size={24} />
                <small>{conference.participants.length || 1}</small>
              </span>
              <span>Participants</span>
            </button>
            <button
              className={`toolbar-control ${chatOpen ? "toolbar-active" : ""}`}
              aria-pressed={chatOpen}
              onClick={() => {
                setChatOpen(!chatOpen);
                setRosterOpen(false);
                setHostToolsOpen(false);
              }}
              aria-label="Show chat"
            >
              <MessageSquare size={24} />
              <span>Chat</span>
            </button>
            <RoomPopover
              open={popover === "reactions"}
              onClose={closePopover}
              label="Meeting reactions"
              trigger={
                <button
                  className={`toolbar-control ${self.hand_raised || popover === "reactions" ? "toolbar-active" : ""}`}
                  aria-label="Reactions"
                  aria-expanded={popover === "reactions"}
                  onClick={() =>
                    setPopover(popover === "reactions" ? null : "reactions")
                  }
                >
                  <Heart size={24} />
                  <span>Reactions</span>
                </button>
              }
            >
              <div className="reaction-options">
                {reactions.map((reaction) => (
                  <button
                    key={reaction.type}
                    aria-label={reaction.label}
                    disabled={conference.connection !== "connected"}
                    onClick={() => {
                      if (Date.now() - lastReaction.current < 1000) {
                        notify("Please wait before reacting again.");
                        return;
                      }
                      if (conference.react(reaction.type))
                        lastReaction.current = Date.now();
                      closePopover();
                    }}
                  >
                    {reaction.emoji}
                  </button>
                ))}
              </div>
              <button
                className="raise-hand-control"
                disabled={conference.connection !== "connected"}
                onClick={() => {
                  conference.raiseHand(!self.hand_raised);
                  closePopover();
                }}
              >
                <Hand size={18} />
                {self.hand_raised ? "Lower Hand" : "Raise Hand"}
              </button>
            </RoomPopover>
            <button
              className={`toolbar-control toolbar-share ${screen.sharing ? "toolbar-active" : ""}`}
              disabled={screen.pending || conference.connection !== "connected"}
              onClick={() => {
                if (screen.sharing) screen.stop();
                else
                  void screen
                    .start()
                    .catch((error) => notify(errorMessage(error)));
              }}
              aria-label={
                screen.sharing ? "Stop sharing screen" : "Share screen"
              }
            >
              <MonitorUp size={24} />
              <span>{screen.sharing ? "Stop Share" : "Share Screen"}</span>
            </button>
            {isHost && (
              <button
                className={`toolbar-control host-tools ${hostToolsOpen ? "toolbar-active" : ""}`}
                aria-pressed={hostToolsOpen}
                onClick={() => {
                  setHostToolsOpen(!hostToolsOpen);
                  setRosterOpen(false);
                  setChatOpen(false);
                }}
              >
                <ShieldCheck size={24} />
                <span>Host Tools</span>
              </button>
            )}
            <RoomPopover
              open={popover === "more"}
              onClose={closePopover}
              label="More meeting controls"
              trigger={
                <button
                  className={`toolbar-control ${popover === "more" ? "toolbar-active" : ""}`}
                  aria-label="More meeting controls"
                  aria-expanded={popover === "more"}
                  onClick={() => setPopover(popover === "more" ? null : "more")}
                >
                  <MoreHorizontal size={24} />
                  <span>More</span>
                </button>
              }
            >
              <button
                onClick={() => {
                  void copy();
                  closePopover();
                }}
              >
                <Link2 size={16} />
                Invite
              </button>
              <button onClick={() => setPopover("info")}>
                <Info size={16} />
                Meeting Info
              </button>
              <button
                onClick={() => {
                  conference.retryMedia();
                  closePopover();
                }}
                disabled={conference.connection !== "connected"}
              >
                Retry media connection
              </button>
            </RoomPopover>
          </div>
          <div className="toolbar-end">
            <button
              className="end-button"
              onClick={() => {
                setNavigationTarget(null);
                if (isHost) setConfirmEnd(true);
                else void leave();
              }}
              disabled={leaving}
            >
              {leaving ? <Spinner size={22} /> : <OctagonX size={24} />}
              <span>{isHost ? "End" : "Leave"}</span>
            </button>
          </div>
        </footer>
        {detailsOpen && meeting && (
          <MeetingDetails
            meeting={meeting}
            onClose={() => setDetailsOpen(false)}
          />
        )}
        {confirmEnd && (
          <Modal
            title={
              navigationTarget ? "Leave this meeting?" : "End this meeting?"
            }
            subtitle={
              navigationTarget
                ? "Leave the call before opening another page. You can return using the invitation link."
                : "This will end the call for everyone. The meeting will appear in your recent meetings."
            }
            onClose={() => setConfirmEnd(false)}
          >
            <div className="dialog-footer">
              <button
                className="button secondary"
                onClick={() => setConfirmEnd(false)}
              >
                Cancel
              </button>
              {navigationTarget && (
                <button
                  className="button secondary"
                  disabled={leaving}
                  onClick={() => void leave(false, navigationTarget)}
                >
                  Leave Meeting
                </button>
              )}
              {isHost && (
                <button
                  className="button danger"
                  onClick={() => void leave(true, navigationTarget ?? "/")}
                  disabled={leaving}
                >
                  {leaving && <Spinner />}End Meeting for All
                </button>
              )}
            </div>
          </Modal>
        )}
        {removeTarget && (
          <Modal
            title={`Remove ${removeTarget.display_name}?`}
            subtitle="They will be disconnected from this meeting. This action ends their current session."
            onClose={() => setRemoveTarget(null)}
          >
            <div className="dialog-footer">
              <button
                className="button secondary"
                onClick={() => setRemoveTarget(null)}
              >
                Cancel
              </button>
              <button
                className="button danger"
                onClick={() => {
                  conference.command("remove-participant", removeTarget.id);
                  setRemoveTarget(null);
                }}
              >
                Remove Participant
              </button>
            </div>
          </Modal>
        )}
      </div>
    </WorkspaceShell>
  );
}
