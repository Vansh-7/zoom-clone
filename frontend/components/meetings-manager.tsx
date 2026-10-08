"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CalendarDays,
  ChevronRight,
  Copy,
  Plus,
  RefreshCw,
  Video,
} from "lucide-react";
import { formatCode, hostToken } from "@/lib/meetings";
import type { Meeting, User } from "@/types";
import { Spinner } from "./ui";

function meetingDate(meeting: Meeting) {
  return new Date(
    meeting.scheduled_at ?? meeting.started_at ?? meeting.created_at,
  );
}
function timeRange(meeting: Meeting) {
  const at = meetingDate(meeting);
  const end = new Date(at.getTime() + meeting.duration_minutes * 60000);
  const options: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  };
  return `${at.toLocaleTimeString(undefined, options)} – ${end.toLocaleTimeString(undefined, options)}`;
}
function dateLabel(at: Date) {
  const today = new Date();
  if (at.toDateString() === today.toDateString()) return "Today";
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (at.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return at.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: at.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
  });
}

export function MeetingsManager({
  upcoming,
  recent,
  user,
  query,
  loading,
  timezone,
  starting,
  onStart,
  onCopy,
  onRefresh,
}: {
  upcoming: Meeting[];
  recent: Meeting[];
  user: User | null;
  query: string;
  loading: boolean;
  timezone: string;
  starting: string;
  onStart: (meeting: Meeting) => Promise<void>;
  onCopy: (meeting: Meeting) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [tab, setTab] = useState<"upcoming" | "recent">("upcoming");
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const filtered = (tab === "upcoming" ? upcoming : recent).filter((meeting) =>
    `${meeting.title} ${meeting.meeting_code}`
      .toLowerCase()
      .includes(query.toLowerCase().replace(/(?<=\d)\s+(?=\d)/g, "")),
  );
  const selected =
    filtered.find((meeting) => meeting.meeting_code === selectedCode) ??
    filtered[0];
  const owns = selected && !!hostToken(selected.meeting_code);
  const groups = new Map<string, Meeting[]>();
  for (const meeting of filtered) {
    const label = dateLabel(meetingDate(meeting));
    groups.set(label, [...(groups.get(label) ?? []), meeting]);
  }
  useEffect(() => {
    if (mobileDetail) heading.current?.focus();
  }, [mobileDetail, selectedCode]);
  function showList() {
    setMobileDetail(false);
    requestAnimationFrame(() => listHeading.current?.focus());
  }
  return (
    <div
      className={`meetings-manager ${mobileDetail && selected ? "manager-show-detail" : ""}`}
    >
      <section className="manager-list" aria-label="Meeting list">
        <div className="manager-list-heading">
          <h2 ref={listHeading} tabIndex={-1}>
            {tab === "upcoming" ? "Upcoming" : "Previous"} meetings
          </h2>
          <button
            className="icon-button"
            aria-label="Refresh meetings"
            disabled={refreshing || loading}
            onClick={async () => {
              setRefreshing(true);
              try {
                await onRefresh();
              } finally {
                setRefreshing(false);
              }
            }}
          >
            <RefreshCw size={16} className={refreshing ? "spin" : ""} />
          </button>
        </div>
        <div className="manager-organizer">
          <span>Your workspace</span>
          <strong>{user?.name ?? "Organizer"}</strong>
          <Link href="/schedule">
            <Plus size={15} />
            Schedule Meeting
          </Link>
        </div>
        <div
          className="tabs manager-tabs"
          role="tablist"
          aria-label="Meeting history"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? "upcoming"
                : event.key === "End"
                  ? "recent"
                  : tab === "upcoming"
                    ? "recent"
                    : "upcoming";
            setTab(next);
            setMobileDetail(false);
            event.currentTarget
              .querySelector<HTMLButtonElement>(
                `#${next === "upcoming" ? "upcoming" : "recent"}-tab`,
              )
              ?.focus();
          }}
        >
          <button
            role="tab"
            id="upcoming-tab"
            aria-controls="meeting-list"
            aria-selected={tab === "upcoming"}
            tabIndex={tab === "upcoming" ? 0 : -1}
            className={tab === "upcoming" ? "tab-active" : ""}
            onClick={() => {
              setTab("upcoming");
              setMobileDetail(false);
            }}
          >
            Upcoming <span>{upcoming.length}</span>
          </button>
          <button
            role="tab"
            id="recent-tab"
            aria-controls="meeting-list"
            aria-selected={tab === "recent"}
            tabIndex={tab === "recent" ? 0 : -1}
            className={tab === "recent" ? "tab-active" : ""}
            onClick={() => {
              setTab("recent");
              setMobileDetail(false);
            }}
          >
            Previous <span>{recent.length}</span>
          </button>
        </div>
        <div
          id="meeting-list"
          className="manager-meeting-list"
          role="tabpanel"
          aria-labelledby={tab === "upcoming" ? "upcoming-tab" : "recent-tab"}
        >
          {loading ? (
            <div className="manager-loading">
              <Spinner />
              Loading meetings…
            </div>
          ) : filtered.length ? (
            [...groups].map(([label, meetings]) => (
              <div className="meeting-date-group" key={label}>
                <h3>{label}</h3>
                {meetings.map((meeting) => (
                  <button
                    className={`manager-meeting ${selected?.meeting_code === meeting.meeting_code ? "manager-meeting-selected" : ""}`}
                    key={meeting.meeting_code}
                    aria-pressed={
                      selected?.meeting_code === meeting.meeting_code
                    }
                    onClick={() => {
                      setSelectedCode(meeting.meeting_code);
                      setMobileDetail(true);
                    }}
                  >
                    <strong>{meeting.title}</strong>
                    <span>{timeRange(meeting)}</span>
                    <span>Host: {meeting.host_name}</span>
                    <span>Meeting ID: {formatCode(meeting.meeting_code)}</span>
                    {meeting.status === "in_progress" && (
                      <span className="manager-live">In progress</span>
                    )}
                  </button>
                ))}
              </div>
            ))
          ) : (
            <div className="empty-state">
              <CalendarDays size={30} />
              <h3>
                {query
                  ? "No meetings found"
                  : `No ${tab === "upcoming" ? "upcoming" : "previous"} meetings`}
              </h3>
              <p>
                {query
                  ? "Try another topic or meeting ID."
                  : tab === "upcoming"
                    ? "Schedule a meeting to get started."
                    : "Completed and missed meetings will appear here."}
              </p>
            </div>
          )}
        </div>
        <div className="manager-timezone">
          <CalendarDays size={14} />
          {timezone.replaceAll("_", " ")} · Local time
        </div>
      </section>
      <section className="manager-detail" aria-label="Selected meeting details">
        <button className="back-link manager-back" onClick={showList}>
          <ArrowLeft size={16} />
          Back to meetings
        </button>
        {selected && !loading ? (
          <div className="meeting-detail-content" key={selected.meeting_code}>
            <h2 ref={heading} tabIndex={-1}>
              {selected.title}
            </h2>
            <div className="manager-detail-meta">
              <p>
                {meetingDate(selected).toLocaleDateString(undefined, {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}
              </p>
              <p>
                {timeRange(selected)}{" "}
                <span className="muted">· {selected.duration_minutes} min</span>
              </p>
              <p>Host: {selected.host_name}</p>
              <p>Meeting ID: {formatCode(selected.meeting_code)}</p>
              {selected.status === "in_progress" && (
                <span className="live-badge">
                  <span />
                  Meeting in progress
                </span>
              )}
              {["ended", "missed"].includes(selected.status) && (
                <span
                  className={`status-badge ${selected.status === "missed" ? "status-missed" : ""}`}
                >
                  {selected.status === "missed" ? "Missed" : "Completed"}
                </span>
              )}
            </div>
            <div className="manager-detail-actions">
              {tab === "upcoming" && (
                <button
                  className="button primary"
                  disabled={starting === selected.meeting_code}
                  onClick={() => void onStart(selected)}
                >
                  {starting === selected.meeting_code && <Spinner size={16} />}
                  {selected.can_claim
                    ? "Start Meeting"
                    : owns
                      ? selected.status === "in_progress"
                        ? "Rejoin"
                        : "Start Meeting"
                      : "Join"}
                </button>
              )}
              <button
                className="button secondary"
                onClick={() => void onCopy(selected)}
              >
                <Copy size={16} />
                Copy Invitation
              </button>
            </div>
            {tab === "upcoming" && selected.can_claim && (
              <p className="manager-access-note">
                Starting this sample meeting gives this browser host access.
              </p>
            )}
            {tab === "upcoming" &&
              !owns &&
              !selected.can_claim &&
              selected.status === "scheduled" && (
                <p className="manager-access-note">
                  You can join when the host starts the meeting.
                </p>
              )}
            {selected.description && (
              <div className="manager-description">
                <h3>Description</h3>
                <p>{selected.description}</p>
              </div>
            )}
            <details className="manager-invitation">
              <summary>
                <ChevronRight size={15} />
                <span className="invitation-show">Show Meeting Invitation</span>
                <span className="invitation-hide">Hide Meeting Invitation</span>
              </summary>
              <div>
                <p>{selected.host_name} is inviting you to a meeting.</p>
                <p>
                  <strong>Topic:</strong> {selected.title}
                  <br />
                  <strong>Time:</strong>{" "}
                  {meetingDate(selected).toLocaleString()} (
                  {timezone.replaceAll("_", " ")})
                </p>
                <label>
                  Join Meeting
                  <input
                    readOnly
                    value={selected.invite_url}
                    aria-label="Invitation link"
                    onFocus={(event) => event.target.select()}
                  />
                </label>
                <p>Meeting ID: {formatCode(selected.meeting_code)}</p>
              </div>
            </details>
          </div>
        ) : (
          <div className="manager-no-selection">
            <Video size={36} strokeWidth={1.3} />
            <h2>
              {loading ? "Getting your meetings ready" : "Your meeting details"}
            </h2>
            <p>
              {loading
                ? "Just a moment…"
                : "Select a meeting to view its invitation and details."}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
