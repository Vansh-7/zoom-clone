"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Globe2, Link2, Plus, Video } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import {
  errorMessage,
  friendlyTimezone,
  localSchedule,
  parseMeetingInput,
  saveHostToken,
} from "@/lib/meetings";
import type { Meeting } from "@/types";
import { ErrorNotice, Spinner } from "./ui";

export function JoinForm({ onCancel }: { onCancel: () => void }) {
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
        <button type="button" className="button secondary" onClick={onCancel}>
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
  );
}

export function ScheduleForm({
  onCancel,
  onScheduled,
}: {
  onCancel: () => void;
  onScheduled: (meeting: Meeting) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [showDescription, setShowDescription] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("10:00");
  const [duration, setDuration] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [{ timezone, minimumDate }, setLocalTime] = useState({
    timezone: "",
    minimumDate: "",
  });
  useEffect(() => {
    const today = new Date();
    // The browser timezone and date can differ from the static build server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalTime({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      minimumDate: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`,
    });
  }, []);
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
    <form className="schedule-form" onSubmit={submit}>
      <div className="schedule-form-row">
        <label htmlFor="schedule-topic">
          <span className="required">*</span> Topic
        </label>
        <div className="schedule-field">
          <input
            id="schedule-topic"
            autoFocus
            disabled={!timezone}
            required
            maxLength={200}
            placeholder="My Meeting"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-invalid={!!fields.title}
            aria-describedby={fields.title ? "topic-error" : undefined}
          />
          {fields.title && (
            <span id="topic-error" className="field-error">
              {fields.title}
            </span>
          )}
        </div>
      </div>
      <div className="schedule-form-row description-row">
        <span />
        {showDescription ? (
          <label className="schedule-field">
            Description <span className="optional">(optional)</span>
            <textarea
              disabled={!timezone}
              maxLength={2000}
              rows={3}
              placeholder="What would you like to discuss?"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
        ) : (
          <button
            type="button"
            className="text-button add-description"
            disabled={!timezone}
            onClick={() => setShowDescription(true)}
          >
            <Plus size={16} />
            Add Description
          </button>
        )}
      </div>
      <div className="schedule-form-row">
        <span className="schedule-label">When</span>
        <div className="schedule-when">
          <label>
            <span className="sr-only">Date</span>
            <input
              aria-label="Date"
              disabled={!timezone}
              type="date"
              min={minimumDate}
              required
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
          <label>
            <span className="sr-only">Time</span>
            <input
              aria-label="Time"
              disabled={!timezone}
              type="time"
              required
              value={time}
              onChange={(event) => setTime(event.target.value)}
            />
          </label>
        </div>
      </div>
      <div className="schedule-form-row">
        <label htmlFor="schedule-duration">Duration</label>
        <div className="schedule-field duration-field">
          <select
            id="schedule-duration"
            disabled={!timezone}
            value={duration}
            onChange={(event) => setDuration(Number(event.target.value))}
          >
            {[15, 30, 45, 60, 90, 120, 180, 240, 480].map((minutes) => (
              <option value={minutes} key={minutes}>
                {minutes < 60
                  ? `${minutes} minutes`
                  : `${Math.floor(minutes / 60)} ${minutes < 120 ? "hour" : "hours"}${minutes % 60 ? ` ${minutes % 60} minutes` : ""}`}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="schedule-form-row">
        <span className="schedule-label">Time Zone</span>
        <div className="schedule-field">
          <div className="schedule-timezone">
            <Globe2 size={16} />
            {friendlyTimezone(timezone, date, time)}
          </div>
          <p className="field-help">
            <span>{timezone.replaceAll("_", " ")}</span>
            <br />
            Meeting times follow your device timezone.
          </p>
        </div>
      </div>
      <div className="schedule-form-row">
        <span className="schedule-label">Meeting ID</span>
        <div className="schedule-field">
          <p className="generated-id">
            <Link2 size={17} />
            Generate Automatically
          </p>
          <p className="field-help">
            A unique ID and invitation link will be created when you save.
          </p>
        </div>
      </div>
      {error && (
        <div className="schedule-form-row">
          <span />
          <ErrorNotice message={error} />
        </div>
      )}
      <div className="schedule-form-row schedule-form-actions">
        <span />
        <div>
          <button
            className="button primary"
            disabled={busy || !title.trim() || !date || !time || !timezone}
          >
            {busy && <Spinner />}Save
          </button>
          <button type="button" className="button secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </form>
  );
}
