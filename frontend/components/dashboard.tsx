"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  CalendarDays,
  Check,
  ChevronRight,
  Clock3,
  Copy,
  Plus,
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
import { MeetingDetails } from "./meeting-dialogs";
import { WorkspaceShell } from "./workspace-shell";
import { MeetingsManager } from "./meetings-manager";
import { ErrorNotice, Spinner, useToast } from "./ui";

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
      <div className="clock-time" suppressHydrationWarning>
        {now
          ? now.toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            })
          : "—:—"}
      </div>
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
  const [timezone, setTimezone] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Meeting | null>(null);
  const [creating, setCreating] = useState(false);
  const [starting, setStarting] = useState("");
  const [query, setQuery] = useState("");

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
      setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
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
                ? "Start Meeting"
                : owns
                  ? meeting.status === "in_progress"
                    ? "Rejoin"
                    : "Start Meeting"
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
          <Link className="text-button" href="/schedule">
            Schedule a meeting <ChevronRight size={15} />
          </Link>
        )}
      </div>
    );
  }

  if (view === "meetings")
    return (
      <WorkspaceShell
        active="meetings"
        user={user}
        loading={loading}
        offline={!!error}
        query={query}
        onQueryChange={setQuery}
      >
        <main className="meetings-main">
          <h1 className="sr-only">Meetings</h1>
          {error && <ErrorNotice message={error} onRetry={() => void load()} />}
          <MeetingsManager
            upcoming={upcoming}
            recent={recent}
            user={user}
            query={query}
            loading={loading}
            timezone={timezone}
            starting={starting}
            onStart={start}
            onCopy={copy}
            onRefresh={load}
          />
        </main>
        {selected && (
          <MeetingDetails
            meeting={selected}
            onClose={() => setSelected(null)}
          />
        )}
      </WorkspaceShell>
    );

  return (
    <WorkspaceShell
      active={view}
      user={user}
      loading={loading}
      offline={!!error}
      query={query}
      onQueryChange={setQuery}
    >
      <main className="dashboard-main">
        <div className="dashboard-inner">
          <h1 className="sr-only">{view === "home" ? "Home" : "Meetings"}</h1>
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
                <span>New Meeting</span>
              </button>
              <Link href="/join" className="quick-action">
                <span className="action-square">
                  <Plus size={30} strokeWidth={2} />
                </span>
                <span>Join</span>
              </Link>
              <Link href="/schedule" className="quick-action">
                <span className="action-square">
                  <CalendarDays size={28} strokeWidth={1.8} />
                </span>
                <span>Schedule</span>
              </Link>
            </div>
            <p className="hero-caption">
              <span
                className={`subtle-status ${error ? "status-offline" : loading ? "status-pending" : ""}`}
              />
              {error
                ? "Waiting for the meeting server."
                : loading
                  ? "Connecting to your workspace…"
                  : "Ready when you are."}
            </p>
          </section>
          {error && <ErrorNotice message={error} onRetry={() => void load()} />}
          <div className="meeting-panels">
            <section className="meeting-panel">
              <div className="panel-heading">
                <h2>
                  Upcoming meetings{" "}
                  <span className="count-badge">{upcoming.length}</span>
                </h2>
                <Link href="/meetings">
                  View all <ChevronRight size={14} />
                </Link>
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
                <div className="home-meeting-list">
                  {next.map((meeting) => meetingRow(meeting))}
                </div>
              ) : (
                empty("upcoming")
              )}
              <div className="panel-footer">
                <CalendarDays size={14} />
                <span>
                  {timezone && (
                    <>
                      {timezone.replaceAll("_", " ")}{" "}
                      <span className="footer-dot">·</span>{" "}
                    </>
                  )}
                  Your local time
                </span>
              </div>
            </section>
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
                <div className="home-meeting-list">
                  {past.map((meeting) => meetingRow(meeting, true))}
                </div>
              ) : (
                empty("recent")
              )}
              <div className="panel-footer">
                <Check size={14} />
                <span>Your meeting history, all in one place</span>
              </div>
            </section>
          </div>
        </div>
      </main>
      {selected && (
        <MeetingDetails meeting={selected} onClose={() => setSelected(null)} />
      )}
    </WorkspaceShell>
  );
}
