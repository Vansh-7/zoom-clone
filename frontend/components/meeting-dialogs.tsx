"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, Clock3, Copy, Globe2, Link2, Video } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import {
  copyText,
  errorMessage,
  formatCode,
  localSchedule,
  parseMeetingInput,
  saveHostToken,
} from "@/lib/meetings";
import type { Meeting } from "@/types";
import { ErrorNotice, Modal, Spinner, useToast } from "./ui";

export function JoinDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const code = parseMeetingInput(input);
      const meeting = await api.meeting(code);
      if (["ended", "missed"].includes(meeting.status))
        throw new ApiError(
          "MEETING_ENDED",
          "This meeting has ended. Ask the host for a new invitation.",
        );
      sessionStorage.setItem(`zoom:name:${code}`, name.trim());
      router.push(`/meeting/${code}`);
    } catch (error) {
      setError(errorMessage(error));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Join Meeting"
      subtitle="Connect with your team in just a moment."
      onClose={onClose}
    >
      <form onSubmit={submit} className="dialog-form">
        <label>
          Meeting ID or invitation link
          <input
            autoFocus
            required
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Enter meeting ID or paste a link"
            autoComplete="off"
          />
        </label>
        <label>
          Your name
          <input
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter your display name"
            autoComplete="name"
          />
        </label>
        <p className="form-note">
          <Video size={16} /> You can check your audio and video before joining.
        </p>
        {error && <ErrorNotice message={error} />}
        <div className="dialog-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy || !name.trim() || !input.trim()}
          >
            {busy && <Spinner />}Join Meeting
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ScheduleDialog({
  onClose,
  onScheduled,
}: {
  onClose: () => void;
  onScheduled: (meeting: Meeting) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("10:00");
  const [duration, setDuration] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = new Date();
  const minimumDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setFields({});
    try {
      const created = await api.schedule({
        title: title.trim(),
        description: description.trim(),
        scheduled_at: localSchedule(date, time),
        scheduled_timezone: timezone,
        duration_minutes: duration,
      });
      saveHostToken(created.meeting.meeting_code, created.host_token);
      onScheduled(created.meeting);
    } catch (error) {
      setError(errorMessage(error));
      if (error instanceof ApiError) setFields(error.fields);
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Schedule Meeting"
      subtitle="Make time for your next great conversation."
      onClose={onClose}
      wide
    >
      <form className="dialog-form" onSubmit={submit}>
        <label>
          Topic <span className="required">*</span>
          <input
            autoFocus
            required
            maxLength={200}
            placeholder="e.g. Weekly team catch-up"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-invalid={!!fields.title}
          />
          {fields.title && <span className="field-error">{fields.title}</span>}
        </label>
        <label>
          Description <span className="optional">(optional)</span>
          <textarea
            maxLength={2000}
            rows={3}
            placeholder="What would you like to discuss?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <div className="form-grid">
          <label>
            Date <span className="required">*</span>
            <input
              aria-label="Date"
              type="date"
              min={minimumDate}
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label>
            Time <span className="required">*</span>
            <input
              aria-label="Time"
              type="time"
              required
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
        </div>
        <div className="form-grid">
          <label>
            Duration
            <select
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            >
              {[15, 30, 45, 60, 90, 120, 180, 240, 480].map((minutes) => (
                <option value={minutes} key={minutes}>
                  {minutes < 60
                    ? `${minutes} minutes`
                    : `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`}
                </option>
              ))}
            </select>
          </label>
          <div className="timezone-field">
            <span>Time zone</span>
            <p>
              <Globe2 size={16} />
              {timezone.replaceAll("_", " ")}
            </p>
            <small>Your device’s local time</small>
          </div>
        </div>
        <div className="schedule-info">
          <Link2 size={17} />
          <span>
            A unique meeting ID and invitation link will be created
            automatically.
          </span>
        </div>
        {error && <ErrorNotice message={error} />}
        <div className="dialog-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || !title.trim()}>
            {busy ? <Spinner /> : <CalendarDays size={17} />}Schedule
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function MeetingDetails({
  meeting,
  onClose,
  scheduled = false,
}: {
  meeting: Meeting;
  onClose: () => void;
  scheduled?: boolean;
}) {
  const notify = useToast();
  const at = new Date(
    meeting.scheduled_at ?? meeting.started_at ?? meeting.created_at,
  );
  async function copy() {
    try {
      await copyText(meeting.invite_url);
      notify("Invitation link copied to clipboard");
    } catch (error) {
      notify(errorMessage(error));
    }
  }
  return (
    <Modal
      title={scheduled ? "Your meeting is scheduled" : "Meeting details"}
      subtitle={
        scheduled
          ? "You're all set. Share the invitation with your team."
          : undefined
      }
      onClose={onClose}
      wide
    >
      <div className="details-content">
        <div className="details-title">
          <div className="details-icon">
            <Video size={24} />
          </div>
          <div>
            <h3>{meeting.title}</h3>
            <span className="muted">Hosted by {meeting.host_name}</span>
          </div>
        </div>
        {meeting.description && (
          <p className="meeting-description">{meeting.description}</p>
        )}
        <div className="detail-line">
          <CalendarDays size={18} />
          <span>
            {at.toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </span>
        </div>
        <div className="detail-line">
          <Clock3 size={18} />
          <span>
            {at.toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })}{" "}
            · {meeting.duration_minutes} minutes ·{" "}
            {Intl.DateTimeFormat().resolvedOptions().timeZone}
          </span>
        </div>
        <div className="invitation-box">
          <span className="label-small">Meeting ID</span>
          <strong>{formatCode(meeting.meeting_code)}</strong>
          <span className="label-small">Invitation link</span>
          <input
            readOnly
            aria-label="Invitation link"
            value={meeting.invite_url}
            onFocus={(event) => event.target.select()}
          />
        </div>
      </div>
      <div className="dialog-footer">
        <button className="button secondary" onClick={onClose}>
          Done
        </button>
        <button className="button primary" onClick={copy}>
          <Copy size={16} />
          Copy Invitation
        </button>
      </div>
    </Modal>
  );
}
