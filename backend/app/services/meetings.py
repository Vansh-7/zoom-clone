import hashlib
import secrets
from datetime import timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import utcnow
from app.models import Meeting, MeetingParticipant, User
from app.schemas import MeetingResponse, ScheduleInput


class AppError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status, self.code, self.message = status, code, message


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def generate_code() -> str:
    return str(secrets.randbelow(90_000_000_000) + 10_000_000_000)


def default_user(db: Session) -> User:
    return db.scalar(select(User).where(User.email == "alex.morgan@example.com"))


def reconcile_schedules(db: Session):
    now = utcnow()
    for meeting in db.scalars(select(Meeting).where(Meeting.status == "scheduled")):
        if meeting.scheduled_at + timedelta(minutes=meeting.duration_minutes) <= now:
            meeting.status = "missed"
    db.commit()


def get_meeting(db: Session, code: str) -> Meeting:
    if len(code) != 11 or not code.isascii() or not code.isdigit():
        raise AppError(
            404,
            "MEETING_NOT_FOUND",
            "This meeting ID doesn't exist. Check the ID and try again.",
        )
    meeting = db.scalar(select(Meeting).where(Meeting.meeting_code == code))
    if meeting is None:
        raise AppError(
            404,
            "MEETING_NOT_FOUND",
            "This meeting ID doesn't exist. Check the ID and try again.",
        )
    if (
        meeting.status == "scheduled"
        and meeting.scheduled_at + timedelta(minutes=meeting.duration_minutes)
        <= utcnow()
    ):
        meeting.status = "missed"
        db.commit()
    return meeting


def list_meetings(db: Session, section: str | None = None):
    reconcile_schedules(db)
    if get_settings().seed_data:
        replenish_samples(db)
    query = select(Meeting)
    if section == "upcoming":
        query = query.where(Meeting.status.in_(["scheduled", "in_progress"])).order_by(
            Meeting.scheduled_at.asc(), Meeting.created_at.desc()
        )
    elif section == "recent":
        query = query.where(Meeting.status.in_(["ended", "missed"])).order_by(
            Meeting.ended_at.desc(), Meeting.scheduled_at.desc()
        )
    else:
        query = query.order_by(Meeting.created_at.desc())
    return [serialize(meeting) for meeting in db.scalars(query.limit(100))]


def serialize(meeting: Meeting) -> MeetingResponse:
    return MeetingResponse(
        meeting_code=meeting.meeting_code,
        title=meeting.title,
        description=meeting.description,
        kind=meeting.kind,
        status=meeting.status,
        host_name=meeting.host.name,
        scheduled_at=meeting.scheduled_at,
        scheduled_timezone=meeting.scheduled_timezone,
        duration_minutes=meeting.duration_minutes,
        started_at=meeting.started_at,
        ended_at=meeting.ended_at,
        created_at=meeting.created_at,
        invite_url=f"{get_settings().frontend_url.rstrip('/')}/meeting/{meeting.meeting_code}",
        can_claim=bool(
            meeting.seed_key
            and not meeting.host_token_hash
            and meeting.status == "scheduled"
        ),
    )


def require_host(meeting: Meeting, token: str | None):
    if (
        not token
        or not meeting.host_token_hash
        or not secrets.compare_digest(meeting.host_token_hash, token_hash(token))
    ):
        raise AppError(403, "HOST_REQUIRED", "Only this meeting's host can do that.")


def create_meeting(db: Session, schedule: ScheduleInput | None = None):
    if schedule and schedule.scheduled_at <= utcnow():
        raise AppError(422, "INVALID_DATE", "Choose a meeting time in the future.")
    token = secrets.token_urlsafe(32)
    for _ in range(5):
        meeting = Meeting(
            meeting_code=generate_code(),
            host_id=default_user(db).id,
            title=schedule.title if schedule else "Alex Morgan's meeting",
            description=schedule.description if schedule else "",
            kind="scheduled" if schedule else "instant",
            status="scheduled" if schedule else "in_progress",
            scheduled_at=schedule.scheduled_at.astimezone(timezone.utc)
            if schedule
            else None,
            scheduled_timezone=schedule.scheduled_timezone if schedule else "UTC",
            duration_minutes=schedule.duration_minutes if schedule else 30,
            started_at=None if schedule else utcnow(),
            host_token_hash=token_hash(token),
        )
        try:
            db.add(meeting)
            db.commit()
            return meeting, token
        except IntegrityError:
            db.rollback()
    raise AppError(
        503,
        "ID_GENERATION_FAILED",
        "We couldn't create a unique meeting. Please try again.",
    )


def claim_demo(db: Session, meeting: Meeting):
    if not meeting.seed_key or meeting.status != "scheduled":
        raise AppError(
            403, "NOT_A_DEMO", "Only unclaimed upcoming sample meetings can be claimed."
        )
    token = secrets.token_urlsafe(32)
    result = db.execute(
        update(Meeting)
        .where(Meeting.id == meeting.id, Meeting.host_token_hash.is_(None))
        .values(host_token_hash=token_hash(token))
    )
    if result.rowcount != 1:
        db.rollback()
        raise AppError(
            409, "ALREADY_CLAIMED", "Another browser already hosts this demo meeting."
        )
    db.commit()
    db.refresh(meeting)
    return token


def start_meeting(db: Session, meeting: Meeting, token: str | None):
    require_host(meeting, token)
    if meeting.status in ("ended", "missed"):
        raise AppError(
            409,
            "MEETING_ENDED",
            "This meeting has ended. Create a new meeting to meet again.",
        )
    if meeting.status == "scheduled":
        meeting.status, meeting.started_at = "in_progress", utcnow()
        db.commit()


def join_meeting(db: Session, meeting: Meeting, name: str, host_token: str | None):
    if meeting.status == "scheduled":
        raise AppError(
            409, "HOST_NOT_STARTED", "Waiting for the host to start this meeting."
        )
    if meeting.status != "in_progress":
        raise AppError(
            409, "MEETING_ENDED", "This meeting has ended and can no longer be joined."
        )
    role = "guest"
    if host_token:
        require_host(meeting, host_token)
        role = "host"
    # BEGIN IMMEDIATE serializes admission, including capacity and the single-host check.
    db.commit()
    db.connection().exec_driver_sql("BEGIN IMMEDIATE")
    db.refresh(meeting)
    if meeting.status != "in_progress":
        raise AppError(409, "MEETING_ENDED", "This meeting has ended.")
    active = list(
        db.scalars(
            select(MeetingParticipant).where(
                MeetingParticipant.meeting_id == meeting.id,
                MeetingParticipant.left_at.is_(None),
            )
        )
    )
    if role == "host" and any(p.role == "host" for p in active):
        raise AppError(
            409,
            "HOST_ALREADY_JOINED",
            "You're already hosting in another tab. Leave there before joining here.",
        )
    if len(active) >= get_settings().max_participants:
        raise AppError(
            409,
            "MEETING_FULL",
            f"This meeting supports up to {get_settings().max_participants} participants. The room is full.",
        )
    token = secrets.token_urlsafe(32)
    participant = MeetingParticipant(
        meeting_id=meeting.id,
        user_id=meeting.host_id if role == "host" else None,
        display_name=name,
        role=role,
        token_hash=token_hash(token),
    )
    db.add(participant)
    db.commit()
    return participant, token


def get_participant(
    db: Session, meeting: Meeting, token: str | None
) -> MeetingParticipant:
    participant = db.scalar(
        select(MeetingParticipant).where(
            MeetingParticipant.meeting_id == meeting.id,
            MeetingParticipant.token_hash == token_hash(token or ""),
        )
    )
    if (
        not participant
        or participant.left_at
        or participant.removed_at
        or meeting.status != "in_progress"
    ):
        raise AppError(
            401, "INVALID_SESSION", "Your meeting session has ended. Please join again."
        )
    return participant


def end_meeting(db: Session, meeting: Meeting):
    if meeting.status == "in_progress":
        meeting.status, meeting.ended_at = "ended", utcnow()
        db.execute(
            update(MeetingParticipant)
            .where(
                MeetingParticipant.meeting_id == meeting.id,
                MeetingParticipant.left_at.is_(None),
            )
            .values(left_at=utcnow())
        )
        db.commit()


def leave_meeting(db: Session, meeting: Meeting, token: str | None) -> int:
    participant = get_participant(db, meeting, token)
    participant.left_at = utcnow()
    db.commit()
    return participant.id


def seed_database(db: Session, samples: bool = True):
    user = default_user(db)
    if user is None:
        user = User(name="Alex Morgan", email="alex.morgan@example.com")
        db.add(user)
        db.commit()
    if not samples:
        return
    titles = [
        "Product design sync",
        "Engineering standup",
        "Weekly team catch-up",
        "Website launch review",
        "Sprint planning",
        "Design feedback session",
    ]
    descriptions = [
        "A quick check-in on our latest designs and what's coming next.",
        "Share progress, discuss blockers, and plan the day ahead.",
        "A little time to reconnect and align on the week.",
        "Review the launch checklist and celebrate the team's work.",
        "Set priorities and agree on the next sprint.",
        "Review the latest ideas and share constructive feedback.",
    ]
    for index, title in enumerate(titles):
        key = f"sample-v1-{index}"
        if db.scalar(select(Meeting.id).where(Meeting.seed_key == key)):
            continue
        future = index < 3
        at = (
            utcnow() + timedelta(hours=[2, 24, 48][index])
            if future
            else utcnow() - timedelta(days=index - 2)
        )
        db.add(
            Meeting(
                meeting_code=str(812_345_670_00 + index),
                host_id=user.id,
                title=title,
                description=descriptions[index],
                kind="scheduled",
                status="scheduled" if future else "ended",
                scheduled_at=at,
                duration_minutes=30 if index % 2 == 0 else 60,
                scheduled_timezone="UTC",
                started_at=None if future else at,
                ended_at=None if future else at + timedelta(minutes=30),
                seed_key=key,
            )
        )
    db.commit()
    replenish_samples(db)


def replenish_samples(db: Session):
    """Keep one future, unclaimed demo per slot without changing existing records."""
    now = utcnow()
    user = default_user(db)
    if user is None:
        return
    for index, (title, hours) in enumerate(
        [
            ("Product design sync", 2),
            ("Engineering standup", 24),
            ("Weekly team catch-up", 48),
        ]
    ):
        prefix = f"sample-upcoming-{index}-"
        available = db.scalar(
            select(Meeting.id).where(
                (Meeting.seed_key == f"sample-v1-{index}")
                | Meeting.seed_key.startswith(prefix),
                Meeting.status == "scheduled",
                Meeting.host_token_hash.is_(None),
                Meeting.scheduled_at > now,
            )
        )
        # At most one replacement per slot per UTC day. Unique seed_key also
        # protects simultaneous dashboard reads and repeated process starts.
        key = f"{prefix}{now.date().isoformat()}"
        if available or db.scalar(select(Meeting.id).where(Meeting.seed_key == key)):
            continue
        for _ in range(5):
            try:
                with db.begin_nested():
                    db.add(
                        Meeting(
                            meeting_code=generate_code(),
                            host_id=user.id,
                            title=title,
                            description="Sample meeting. Claim host access to try a call.",
                            kind="scheduled",
                            status="scheduled",
                            scheduled_at=now + timedelta(hours=hours),
                            duration_minutes=30 if index % 2 == 0 else 60,
                            scheduled_timezone="UTC",
                            seed_key=key,
                        )
                    )
                break
            except IntegrityError:
                if db.scalar(select(Meeting.id).where(Meeting.seed_key == key)):
                    break
        db.commit()
