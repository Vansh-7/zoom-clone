"""RFC 5545 export: UTC instants, escaped text, CRLF, 75-octet folding."""

from datetime import UTC, timedelta
from urllib.parse import urlsplit

from app.models import Meeting
from app.services.meetings import AppError, serialize


def escape_text(value: str) -> str:
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    value = "".join(char for char in value if ord(char) >= 32 or char in "\n\t")
    return (
        value.replace("\\", "\\\\")
        .replace("\n", "\\n")
        .replace(";", "\\;")
        .replace(",", "\\,")
    )


def fold_line(value: str) -> str:
    lines = []
    line = ""
    size = 0
    for char in value:
        width = len(char.encode("utf-8"))
        if size + width > 75:
            lines.append(line)
            line, size = " ", 1
        line += char
        size += width
    lines.append(line)
    return "\r\n".join(lines)


def calendar_file(meeting: Meeting) -> str:
    if meeting.kind != "scheduled" or meeting.scheduled_at is None:
        raise AppError(
            409,
            "NOT_SCHEDULED",
            "Calendar invitations are available for scheduled meetings.",
        )
    invitation = serialize(meeting).invite_url
    start = meeting.scheduled_at.astimezone(UTC)
    end = start + timedelta(minutes=meeting.duration_minutes)
    description = f"{meeting.description}\n\nJoin: {invitation}\nMeeting ID: {meeting.meeting_code}".strip()
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Zoom Clone//Meeting Calendar//EN",
        "CALSCALE:GREGORIAN",
        "BEGIN:VEVENT",
        f"UID:{meeting.meeting_code}@{urlsplit(invitation).hostname}",
        f"DTSTAMP:{meeting.created_at.astimezone(UTC):%Y%m%dT%H%M%SZ}",
        f"DTSTART:{start:%Y%m%dT%H%M%SZ}",
        f"DTEND:{end:%Y%m%dT%H%M%SZ}",
        f"SUMMARY:{escape_text(meeting.title)}",
        f"DESCRIPTION:{escape_text(description)}",
        f"URL:{invitation}",
        "END:VEVENT",
        "END:VCALENDAR",
    ]
    return "\r\n".join(fold_line(line) for line in lines) + "\r\n"
