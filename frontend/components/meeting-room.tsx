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
  Expand,
  Info,
  Link2,
  LockKeyhole,
  Mic,
  MicOff,
  MonitorUp,
  MessageSquare,
  ShieldCheck,
  Signal,
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
import type { Admission, Meeting, Participant } from "@/types";
import { MeetingDetails } from "./meeting-dialogs";
import { MeetingChat } from "./meeting-chat";
import { ErrorNotice, Modal, Spinner, useToast } from "./ui";

function VideoTile({
  stream,
  participant,
  local = false,
  videoEnabled,
  connectionState,
}: {
  stream?: MediaStream | null;
  participant: Participant;
  local?: boolean;
  videoEnabled: boolean;
  connectionState?: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  useEffect(() => {
    if (video.current && stream) {
      video.current.srcObject = stream;
      void video.current.play().catch(() => setAutoplayBlocked(true));
    }
  }, [stream]);
  return (
    <div
      className={`video-tile ${local ? "local-tile" : ""} ${participant.screen_sharing ? "screen-tile" : ""}`}
      data-participant-id={participant.id}
    >
      <video
        ref={video}
        autoPlay
        playsInline
        muted={local}
        className={`${local && !participant.screen_sharing ? "mirrored" : ""} ${videoEnabled && stream ? "" : "video-hidden"}`}
        aria-label={`${participant.display_name}${local ? " (you)" : ""} video`}
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
        {participant.screen_sharing && (
          <span className="tile-sharing">Sharing screen</span>
        )}
      </div>
      {autoplayBlocked && (
        <button
          className="play-audio"
          onClick={() => {
            void video.current?.play().then(() => setAutoplayBlocked(false));
          }}
        >
          Click to enable audio
        </button>
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
  const [removeTarget, setRemoveTarget] = useState<Participant | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [duration, setDuration] = useState(0);
  const media = useLocalMedia();
  const screen = useScreenShare(media.stream);
  const conference = useConference(
    code,
    admission,
    screen.stream,
    media.audioEnabled,
    screen.sharing || media.videoEnabled,
    media.muteAudio,
    notify,
    screen.sharing,
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
  async function leave(endForAll = false) {
    setLeaving(true);
    try {
      if (endForAll && ownerToken) await api.end(code, ownerToken);
      else if (admission) await api.leave(code, admission.participant_token);
      media.stop();
      screen.stop();
      router.push("/");
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
          zoom<span>Workplace</span>
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
            zoom<span>Workplace</span>
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
  return (
    <div className="meeting-room">
      <header className="room-header">
        <div className="room-brand">
          zoom<span>Workplace</span>
        </div>
        <div className="room-topic">
          <ShieldCheck size={17} />
          <button onClick={() => setDetailsOpen(true)}>
            {meeting?.title}
            <ChevronDown size={13} />
          </button>
        </div>
        <div className="room-header-right">
          <span
            className={`room-connection ${conference.connection !== "connected" ? "room-offline" : ""}`}
          >
            <Signal size={14} />
            {conference.connection === "connected"
              ? "Connected"
              : conference.connection === "disconnected"
                ? "Disconnected"
                : "Connecting"}
          </span>
          <span className="room-timer">
            {Math.floor(duration / 60)
              .toString()
              .padStart(2, "0")}
            :{(duration % 60).toString().padStart(2, "0")}
          </span>
          <button
            className="room-view-button"
            onClick={() => {
              if (document.fullscreenElement) void document.exitFullscreen();
              else
                void document.documentElement
                  .requestFullscreen()
                  .catch(() =>
                    notify("Full screen isn't available in this browser."),
                  );
            }}
            aria-label="Toggle full screen"
          >
            <Expand size={15} />
            <span>Full screen</span>
          </button>
        </div>
      </header>
      <div className="room-content">
        <main className="meeting-stage">
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
          <div
            className={`video-grid ${others.length === 0 ? "video-grid-solo" : ""}`}
          >
            <VideoTile
              stream={screen.stream}
              participant={{
                ...self,
                audio_enabled: media.audioEnabled,
                screen_sharing: screen.sharing,
              }}
              local
              videoEnabled={screen.sharing || media.videoEnabled}
            />
            {others.map((participant) => (
              <VideoTile
                key={participant.id}
                participant={participant}
                stream={conference.remoteStreams[participant.id]}
                videoEnabled={!!participant.video_enabled}
                connectionState={
                  conference.peerStates[participant.id] ?? "connecting"
                }
              />
            ))}
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
          <aside className="participants-panel">
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
            <button
              className="button secondary invite-participants"
              onClick={() => void copy()}
            >
              <Link2 size={15} />
              Invite
            </button>
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
                    <span>
                      {participant.role === "host" ? "Host" : "Participant"}
                    </span>
                  </div>
                  <span className="participant-mic">
                    {participant.audio_enabled ? (
                      <Mic size={16} />
                    ) : (
                      <MicOff size={16} />
                    )}
                  </span>
                  {isHost && participant.id !== self.id && (
                    <button
                      className="remove-participant"
                      aria-label={`Remove ${participant.display_name}`}
                      onClick={() => setRemoveTarget(participant)}
                    >
                      <X size={15} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {isHost && (
              <div className="participants-footer">
                <button
                  className="button secondary"
                  onClick={() => conference.command("mute-all")}
                  disabled={conference.connection !== "connected"}
                >
                  <MicOff size={15} />
                  Mute All
                </button>
              </div>
            )}
          </aside>
        )}
        {chatOpen && (
          <MeetingChat
            messages={conference.chatMessages}
            connected={conference.connection === "connected"}
            selfId={self.id}
            send={conference.sendChat}
            onClose={() => setChatOpen(false)}
          />
        )}
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
            {media.videoEnabled ? <Video size={25} /> : <VideoOff size={25} />}
            <span>{media.videoEnabled ? "Stop Video" : "Start Video"}</span>
          </button>
        </div>
        <div className="toolbar-center">
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
            aria-label={screen.sharing ? "Stop sharing screen" : "Share screen"}
          >
            <MonitorUp size={24} />
            <span>{screen.sharing ? "Stop Share" : "Share Screen"}</span>
          </button>
          <button
            className={`toolbar-control ${rosterOpen ? "toolbar-active" : ""}`}
            onClick={() => {
              setRosterOpen(!rosterOpen);
              setChatOpen(false);
            }}
            aria-label="Show participants"
          >
            <span className="toolbar-count-icon">
              <Users size={24} />
              <small>{conference.participants.length || 1}</small>
            </span>
            <span>Participants</span>
          </button>
          <button className="toolbar-control" onClick={() => void copy()}>
            <Link2 size={24} />
            <span>Invite</span>
          </button>
          <button
            className={`toolbar-control ${chatOpen ? "toolbar-active" : ""}`}
            onClick={() => {
              setChatOpen(!chatOpen);
              setRosterOpen(false);
            }}
            aria-label="Show chat"
          >
            <MessageSquare size={24} />
            <span>Chat</span>
          </button>
          <button
            className="toolbar-control toolbar-info"
            onClick={() => setDetailsOpen(true)}
          >
            <Info size={24} />
            <span>Meeting Info</span>
          </button>
          {isHost && (
            <button
              className="toolbar-control host-tools"
              onClick={() => {
                setRosterOpen(true);
                setChatOpen(false);
              }}
            >
              <ShieldCheck size={24} />
              <span>Host Tools</span>
            </button>
          )}
        </div>
        <div className="toolbar-end">
          <button
            className="end-button"
            onClick={() => {
              if (isHost) setConfirmEnd(true);
              else void leave();
            }}
            disabled={leaving}
          >
            {leaving ? <Spinner size={14} /> : null}
            {isHost ? "End" : "Leave"}
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
          title="End this meeting?"
          subtitle="This will end the call for everyone. The meeting will appear in your recent meetings."
          onClose={() => setConfirmEnd(false)}
        >
          <div className="dialog-footer">
            <button
              className="button secondary"
              onClick={() => setConfirmEnd(false)}
            >
              Cancel
            </button>
            <button
              className="button danger"
              onClick={() => void leave(true)}
              disabled={leaving}
            >
              {leaving && <Spinner />}End Meeting for All
            </button>
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
  );
}
