"use client";

import { CalendarDays, Clock3, Copy, Video } from "lucide-react";
import { copyText, errorMessage, formatCode } from "@/lib/meetings";
import type { Meeting } from "@/types";
import { Modal, useToast } from "./ui";

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
