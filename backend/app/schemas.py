from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ScheduleInput(StrictInput):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    scheduled_at: AwareDatetime
    scheduled_timezone: str = "UTC"
    duration_minutes: int = Field(default=30, ge=5, le=480, strict=True)

    @field_validator("scheduled_timezone")
    @classmethod
    def valid_timezone(cls, value):
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("Choose a valid IANA timezone")
        return value


class JoinInput(StrictInput):
    display_name: str = Field(min_length=1, max_length=80)


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    email: str


class MeetingResponse(BaseModel):
    meeting_code: str
    title: str
    description: str
    kind: Literal["instant", "scheduled"]
    status: Literal["scheduled", "in_progress", "ended", "missed"]
    host_name: str
    scheduled_at: datetime | None
    scheduled_timezone: str
    duration_minutes: int
    started_at: datetime | None
    ended_at: datetime | None
    created_at: datetime
    invite_url: str
    can_claim: bool


class CreatedMeeting(BaseModel):
    meeting: MeetingResponse
    host_token: str


class ParticipantResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    display_name: str
    role: Literal["host", "guest"]


class JoinResponse(BaseModel):
    participant: ParticipantResponse
    participant_token: str
    meeting: MeetingResponse
