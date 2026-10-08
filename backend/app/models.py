from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, UTCDateTime, utcnow


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    email: Mapped[str] = mapped_column(String(254), unique=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    meetings: Mapped[list["Meeting"]] = relationship(back_populates="host")


class Meeting(Base):
    __tablename__ = "meetings"
    __table_args__ = (
        CheckConstraint("kind IN ('instant', 'scheduled')"),
        CheckConstraint("status IN ('scheduled', 'in_progress', 'ended', 'missed')"),
        CheckConstraint("duration_minutes BETWEEN 5 AND 480"),
        Index("ix_meetings_status_scheduled", "status", "scheduled_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    meeting_code: Mapped[str] = mapped_column(String(11), unique=True, index=True)
    host_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    kind: Mapped[str] = mapped_column(String(12))
    status: Mapped[str] = mapped_column(String(16))
    scheduled_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    scheduled_timezone: Mapped[str] = mapped_column(String(80), default="UTC")
    duration_minutes: Mapped[int] = mapped_column(default=30)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    ended_at: Mapped[datetime | None] = mapped_column(UTCDateTime, index=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    host_token_hash: Mapped[str | None] = mapped_column(String(64))
    seed_key: Mapped[str | None] = mapped_column(String(40), unique=True)
    host: Mapped[User] = relationship(back_populates="meetings")
    participants: Mapped[list["MeetingParticipant"]] = relationship(
        back_populates="meeting"
    )


class MeetingParticipant(Base):
    __tablename__ = "meeting_participants"
    __table_args__ = (
        CheckConstraint("role IN ('host', 'guest')"),
        Index("ix_participants_meeting_left", "meeting_id", "left_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    meeting_id: Mapped[int] = mapped_column(ForeignKey("meetings.id"))
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    display_name: Mapped[str] = mapped_column(String(80))
    joined_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    left_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    removed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    role: Mapped[str] = mapped_column(String(8))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    meeting: Mapped[Meeting] = relationship(back_populates="participants")
