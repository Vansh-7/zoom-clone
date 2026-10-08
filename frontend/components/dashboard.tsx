"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  Home,
  Info,
  Link2,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Users,
  Video,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  copyText,
  errorMessage,
  formatCode,
  hostToken,
  saveHostToken,
} from "@/lib/meetings";
import type { Meeting, User } from "@/types";
import { JoinDialog, MeetingDetails, ScheduleDialog } from "./meeting-dialogs";
import { ErrorNotice, Modal, Spinner, useToast } from "./ui";

function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="home-clock">
      <h1 suppressHydrationWarning>
        {now
          ? now.toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })
          : "—:—"}
      </h1>
      <p>
        {now?.toLocaleDateString(undefined, {
          weekday: "long",
          month: "long",
          day: "numeric",
        }) ?? "Your daily workspace"}
      </p>
    </div>
  );
}

export function Dashboard({ view }: { view: "home" | "meetings" }) {
  const router = useRouter();
  const notify = useToast();
  const [user, setUser] = useState<User | null>(null);
  const [upcoming, setUpcoming] = useState<Meeting[]>([]);
  const [recent, setRecent] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<
    "join" | "schedule" | "profile" | "settings" | "help" | null
  >(null);
  const [selected, setSelected] = useState<Meeting | null>(null);
  const [scheduled, setScheduled] = useState(false);
  const [creating, setCreating] = useState(false);
  const [starting, setStarting] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"upcoming" | "recent">("upcoming");

  const load = useCallback(async () => {
    try {
      const [profile, next, past] = await Promise.all([
        api.user(),
        api.upcoming(),
        api.recent(),
      ]);
      setUser(profile);
      setUpcoming(next);
      setRecent(past);
      setError("");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);
  // Initial client data loading synchronizes this SPA with the external REST API.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  useEffect(() => {
    const refresh = () => {
      void load();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load]);

  async function instant() {
    setCreating(true);
    try {
      const result = await api.instant();
      saveHostToken(result.meeting.meeting_code, result.host_token);
      sessionStorage.setItem(
        `zoom:name:${result.meeting.meeting_code}`,
        user?.name ?? "Alex Morgan",
      );
      notify("Your meeting is ready");
      router.push(`/meeting/${result.meeting.meeting_code}`);
    } catch (error) {
      notify(errorMessage(error));
      setCreating(false);
    }
  }
  async function start(meeting: Meeting) {
    setStarting(meeting.meeting_code);
    try {
      let token = hostToken(meeting.meeting_code);
      if (!token && meeting.can_claim) {
        const result = await api.claim(meeting.meeting_code);
        token = result.host_token;
        saveHostToken(meeting.meeting_code, token);
      }
      if (token) {
        await api.start(meeting.meeting_code, token);
        sessionStorage.setItem(
          `zoom:name:${meeting.meeting_code}`,
          user?.name ?? "Alex Morgan",
        );
      }
      router.push(`/meeting/${meeting.meeting_code}`);
    } catch (error) {
      notify(errorMessage(error));
      setStarting("");
    }
  }
  async function copy(meeting: Meeting) {
    try {
      await copyText(meeting.invite_url);
      notify("Invitation link copied to clipboard");
    } catch (error) {
      notify(errorMessage(error));
      setSelected(meeting);
    }
  }
  const matches = (meeting: Meeting) =>
    `${meeting.title} ${meeting.meeting_code}`
      .toLowerCase()
      .includes(query.toLowerCase().replace(/(?<=\d)\s+(?=\d)/g, ""));
  const next = upcoming.filter(matches);
  const past = recent.filter(matches);

  function meetingRow(meeting: Meeting, isRecent = false) {
    const at = new Date(
      meeting.scheduled_at ?? meeting.started_at ?? meeting.created_at,
    );
    const owns =
      typeof window !== "undefined" && !!hostToken(meeting.meeting_code);
    return (
      <article
        className={`meeting-row ${meeting.status === "in_progress" ? "meeting-live" : ""}`}
        key={meeting.meeting_code}
      >
        <div className={`date-square ${isRecent ? "date-past" : ""}`}>
          <span>
            {at.toLocaleDateString(undefined, { month: "short" }).toUpperCase()}
          </span>
          <strong>{at.getDate()}</strong>
        </div>
        <div className="meeting-row-body">
          <button
            className="meeting-title"
            onClick={() => {
              setSelected(meeting);
              setScheduled(false);
            }}
          >
            {meeting.title}
          </button>
          <p className="meeting-time">
            {at.toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })}
            <span className="dot-separator">·</span>
            {meeting.duration_minutes} min
            {meeting.status === "in_progress" && (
              <span className="live-badge">
                <span />
                Live
              </span>
            )}
          </p>
          <p className="meeting-id">
            Meeting ID: {formatCode(meeting.meeting_code)}
          </p>
        </div>
        <div className="meeting-row-actions">
          {isRecent ? (
            <span
              className={`status-badge ${meeting.status === "missed" ? "status-missed" : ""}`}
            >
              {meeting.status === "missed" ? (
                "Missed"
              ) : (
                <>
                  <Check size={12} />
                  Completed
                </>
              )}
            </span>
          ) : (
            <button
              className={`button small ${owns || meeting.can_claim ? "outline-blue" : "secondary"}`}
              onClick={() => void start(meeting)}
              disabled={starting === meeting.meeting_code}
              title={
                meeting.can_claim
                  ? "Claim host access for this sample meeting and start it"
                  : undefined
              }
            >
              {starting === meeting.meeting_code ? <Spinner size={14} /> : null}
              {meeting.can_claim
                ? "Start demo"
                : owns
                  ? meeting.status === "in_progress"
                    ? "Rejoin"
                    : "Start"
                  : "Join"}
            </button>
          )}
          <button
            className="icon-button copy-row"
            aria-label={`Copy invitation for ${meeting.title}`}
            title="Copy invitation"
            onClick={() => void copy(meeting)}
          >
            <Copy size={16} />
          </button>
        </div>
      </article>
    );
  }

  function empty(label: string) {
    return (
      <div className="empty-state">
        <div className="empty-icon">
          <CalendarDays size={30} strokeWidth={1.5} />
        </div>
        <h3>{query ? "No meetings found" : `No ${label} meetings`}</h3>
        <p>
          {query
            ? "Try another topic or meeting ID."
            : label === "upcoming"
              ? "A little room in your calendar. Schedule your next conversation."
              : "Your completed meetings will appear here."}
        </p>
        {!query && label === "upcoming" && (
          <button className="text-button" onClick={() => setDialog("schedule")}>
            Schedule a meeting <ChevronRight size={15} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="workspace">
      <header className="app-header">
        <Link className="wordmark" href="/" aria-label="Zoom Workplace Home">
          zoom<span>Workplace</span>
        </Link>
        <div className="header-history">
          <button
            className="icon-button"
            aria-label="Go back"
            onClick={() => window.history.back()}
          >
            <ArrowLeft size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Go forward"
            onClick={() => window.history.forward()}
          >
            <ArrowRight size={16} />
          </button>
        </div>
        <div className="header-search">
          <Search size={17} />
          <input
            aria-label="Search meetings"
            placeholder="Search meetings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="search-hint">Meetings</span>
        </div>
        <div className="header-right">
          <span className="connection-label">
            <span />
            {error ? "Offline" : "Available"}
          </span>
          <button
            className="icon-button header-settings"
            aria-label="Settings"
            onClick={() => setDialog("settings")}
          >
            <Settings size={19} />
          </button>
          <button
            className="profile-avatar"
            aria-label="Open profile"
            onClick={() => setDialog("profile")}
          >
            AM
            <span />
          </button>
        </div>
      </header>
      <aside className="sidebar" aria-label="Main navigation">
        <nav>
          <Link
            href="/"
            className={`nav-item ${view === "home" ? "nav-active" : ""}`}
            aria-current={view === "home" ? "page" : undefined}
          >
            <Home size={22} strokeWidth={1.8} />
            <span>Home</span>
          </Link>
          <Link
            href="/meetings"
            className={`nav-item ${view === "meetings" ? "nav-active" : ""}`}
            aria-current={view === "meetings" ? "page" : undefined}
          >
            <Video size={22} strokeWidth={1.8} />
            <span>Meetings</span>
          </Link>
          <button
            className="nav-item nav-disabled"
            disabled
            title="Contacts aren't included in this demo"
          >
            <Users size={22} strokeWidth={1.8} />
            <span>Contacts</span>
          </button>
          <button
            className="nav-item nav-disabled"
            disabled
            title="Additional Zoom products aren't included"
          >
            <MoreHorizontal size={23} />
            <span>More</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button
            className="nav-item"
            onClick={() => setDialog("help")}
            aria-label="Help"
          >
            <CircleHelp size={21} />
            <span>Help</span>
          </button>
          <button
            className="nav-item"
            onClick={() => setDialog("settings")}
            aria-label="Workspace settings"
          >
            <Settings size={21} />
            <span>Settings</span>
          </button>
        </div>
      </aside>
      <main className="dashboard-main">
        <div className="dashboard-inner">
          <div className="page-heading">
            <div>
              <span className="workspace-eyebrow">PERSONAL WORKSPACE</span>
              <h2>{view === "home" ? "Home" : "Meetings"}</h2>
            </div>
            <span className="workspace-chip">
              <span />
              {user?.name ?? "Your workspace"}
            </span>
          </div>
          {view === "home" ? (
            <section className="home-hero" aria-label="Meeting actions">
              <Clock />
              <div className="quick-actions">
                <button
                  onClick={() => void instant()}
                  disabled={creating}
                  className="quick-action"
                >
                  <span className="action-square action-orange">
                    {creating ? (
                      <Spinner size={29} />
                    ) : (
                      <Video size={30} strokeWidth={1.8} />
                    )}
                  </span>
                  <span>
                    New Meeting <ChevronDown size={12} />
                  </span>
                </button>
                <button
                  onClick={() => setDialog("join")}
                  className="quick-action"
                >
                  <span className="action-square">
                    <Plus size={30} strokeWidth={2} />
                  </span>
                  <span>Join</span>
                </button>
                <button
                  onClick={() => setDialog("schedule")}
                  className="quick-action"
                >
                  <span className="action-square">
                    <CalendarDays size={28} strokeWidth={1.8} />
                  </span>
                  <span>Schedule</span>
                </button>
              </div>
              <p className="hero-caption">
                <span className="subtle-status" />
                Ready when you are.
              </p>
            </section>
          ) : (
            <div className="meetings-toolbar">
              <div className="tabs">
                <button
                  className={tab === "upcoming" ? "tab-active" : ""}
                  onClick={() => setTab("upcoming")}
                >
                  Upcoming <span>{upcoming.length}</span>
                </button>
                <button
                  className={tab === "recent" ? "tab-active" : ""}
                  onClick={() => setTab("recent")}
                >
                  Previous <span>{recent.length}</span>
                </button>
              </div>
              <button
                className="button primary"
                onClick={() => setDialog("schedule")}
              >
                <Plus size={17} />
                Schedule Meeting
              </button>
            </div>
          )}
          {error && <ErrorNotice message={error} onRetry={() => void load()} />}
          <div
            className={`meeting-panels ${view === "meetings" ? "panels-full" : ""}`}
          >
            {(view === "home" || tab === "upcoming") && (
              <section className="meeting-panel">
                <div className="panel-heading">
                  <h2>
                    Upcoming meetings{" "}
                    <span className="count-badge">{upcoming.length}</span>
                  </h2>
                  {view === "home" ? (
                    <Link href="/meetings">
                      View all <ChevronRight size={14} />
                    </Link>
                  ) : (
                    <button className="text-button" onClick={() => void load()}>
                      <Clock3 size={15} />
                      Refresh
                    </button>
                  )}
                </div>
                {loading ? (
                  <div className="skeleton-list">
                    {[1, 2, 3].map((n) => (
                      <div className="skeleton-row" key={n}>
                        <div />
                        <span />
                        <span />
                      </div>
                    ))}
                  </div>
                ) : next.length ? (
                  <div>{next.map((meeting) => meetingRow(meeting))}</div>
                ) : (
                  empty("upcoming")
                )}
                <div className="panel-footer">
                  <CalendarDays size={14} />
                  <span>
                    {Intl.DateTimeFormat()
                      .resolvedOptions()
                      .timeZone.replaceAll("_", " ")}{" "}
                    <span className="footer-dot">·</span> Your local time
                  </span>
                </div>
              </section>
            )}
            {(view === "home" || tab === "recent") && (
              <section className="meeting-panel">
                <div className="panel-heading">
                  <h2>Recent meetings</h2>
                  <Clock3 size={17} className="muted" />
                </div>
                {loading ? (
                  <div className="skeleton-list">
                    {[1, 2, 3].map((n) => (
                      <div className="skeleton-row" key={n}>
                        <div />
                        <span />
                        <span />
                      </div>
                    ))}
                  </div>
                ) : past.length ? (
                  <div>
                    {past
                      .slice(0, view === "home" ? 3 : 100)
                      .map((meeting) => meetingRow(meeting, true))}
                  </div>
                ) : (
                  empty("recent")
                )}
                <div className="panel-footer">
                  <Check size={14} />
                  <span>Your meeting history, all in one place</span>
                </div>
              </section>
            )}
          </div>
          <footer className="workspace-footer">
            <span>
              <Video size={14} />
              Connect. Collaborate. Get things done.
            </span>
            <button onClick={() => setDialog("help")}>
              Need a hand? <CircleHelp size={14} />
            </button>
          </footer>
        </div>
      </main>
      {dialog === "join" && <JoinDialog onClose={() => setDialog(null)} />}
      {dialog === "schedule" && (
        <ScheduleDialog
          onClose={() => setDialog(null)}
          onScheduled={(meeting) => {
            setDialog(null);
            setSelected(meeting);
            setScheduled(true);
            notify("Meeting scheduled successfully");
            void load();
          }}
        />
      )}
      {selected && (
        <MeetingDetails
          meeting={selected}
          scheduled={scheduled}
          onClose={() => {
            setSelected(null);
            setScheduled(false);
          }}
        />
      )}
      {dialog === "profile" && (
        <Modal title="Your profile" onClose={() => setDialog(null)}>
          <div className="placeholder-content">
            <div className="large-avatar">AM</div>
            <h3>{user?.name ?? "Alex Morgan"}</h3>
            <p>{user?.email ?? "alex.morgan@example.com"}</p>
            <div className="schedule-info">
              <Info size={18} />
              <span>
                This workspace uses a default organizer. Account editing and
                login aren’t required for this assignment.
              </span>
            </div>
          </div>
        </Modal>
      )}
      {dialog === "settings" && (
        <Modal
          title="Settings"
          subtitle="Workspace preferences"
          onClose={() => setDialog(null)}
        >
          <div className="placeholder-content settings-content">
            <div>
              <GlobeSetting />
              <span>
                Time zone
                <strong>
                  {Intl.DateTimeFormat().resolvedOptions().timeZone}
                </strong>
              </span>
            </div>
            <div>
              <Video size={20} />
              <span>
                Audio & video
                <strong>Check your devices before joining a meeting.</strong>
              </span>
            </div>
            <p>
              Profile editing and additional preferences are placeholders. Your
              browser manages camera and microphone permissions.
            </p>
          </div>
        </Modal>
      )}
      {dialog === "help" && (
        <Modal
          title="A little help getting started"
          onClose={() => setDialog(null)}
        >
          <div className="help-content">
            <p>
              <strong>New Meeting</strong> creates an instant room. Continue
              through the preview to connect audio and video.
            </p>
            <p>
              <strong>Join</strong> accepts an 11-digit ID or an invitation from
              this app. Enter your name before joining.
            </p>
            <p>
              <strong>Schedule</strong> saves a future meeting in your device’s
              timezone. Only the creating browser can start it.
            </p>
            <p>
              <strong>Start demo</strong> claims a sample meeting for this
              browser. Each demo can be claimed once.
            </p>
            <p className="form-note">
              <Link2 size={17} />
              Use Copy Invitation to invite someone in a different browser.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}

function GlobeSetting() {
  return <CalendarDays size={20} />;
}
