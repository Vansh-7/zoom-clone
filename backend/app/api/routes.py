from typing import Annotated

from fastapi import APIRouter, Depends, Header, WebSocket
from sqlalchemy import text
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.config import get_settings
from app.database import get_db
from app.schemas import (
    CreatedMeeting,
    JoinInput,
    JoinResponse,
    MeetingResponse,
    ScheduleInput,
    UserResponse,
)
from app.services import meetings as service
from app.websocket.manager import manager

router = APIRouter(prefix="/api")
ws_router = APIRouter()
DB = Annotated[Session, Depends(get_db)]


def bearer(authorization: Annotated[str | None, Header()] = None) -> str | None:
    if not authorization:
        return None
    scheme, _, value = authorization.partition(" ")
    return value if scheme.lower() == "bearer" and value else None


Token = Annotated[str | None, Depends(bearer)]


@router.get("/health")
def health(db: DB):
    db.execute(text("SELECT 1"))
    return {"status": "ok", "database": "sqlite"}


@router.get("/user", response_model=UserResponse)
def user(db: DB):
    return service.default_user(db)


@router.get("/meetings", response_model=list[MeetingResponse])
def meetings(db: DB):
    return service.list_meetings(db)


@router.get("/meetings/upcoming", response_model=list[MeetingResponse])
def upcoming(db: DB):
    return service.list_meetings(db, "upcoming")


@router.get("/meetings/recent", response_model=list[MeetingResponse])
def recent(db: DB):
    return service.list_meetings(db, "recent")


@router.post("/meetings/instant", response_model=CreatedMeeting, status_code=201)
def instant(db: DB):
    meeting, token = service.create_meeting(db)
    return {"meeting": service.serialize(meeting), "host_token": token}


@router.post("/meetings/schedule", response_model=CreatedMeeting, status_code=201)
def schedule(body: ScheduleInput, db: DB):
    meeting, token = service.create_meeting(db, body)
    return {"meeting": service.serialize(meeting), "host_token": token}


@router.get("/meetings/{code}", response_model=MeetingResponse)
def detail(code: str, db: DB):
    return service.serialize(service.get_meeting(db, code))


@router.post("/meetings/{code}/claim", response_model=CreatedMeeting)
def claim(code: str, db: DB):
    meeting = service.get_meeting(db, code)
    token = service.claim_demo(db, meeting)
    return {"meeting": service.serialize(meeting), "host_token": token}


@router.post("/meetings/{code}/start", response_model=MeetingResponse)
def start(code: str, db: DB, token: Token):
    meeting = service.get_meeting(db, code)
    service.start_meeting(db, meeting, token)
    return service.serialize(meeting)


@router.post("/meetings/{code}/join", response_model=JoinResponse, status_code=201)
def join(code: str, body: JoinInput, db: DB, token: Token):
    meeting = service.get_meeting(db, code)
    participant, participant_token = service.join_meeting(
        db, meeting, body.display_name, token
    )
    return {
        "participant": participant,
        "participant_token": participant_token,
        "meeting": service.serialize(meeting),
    }


@router.post("/meetings/{code}/leave")
async def leave(code: str, db: DB, token: Token):
    def finish():
        meeting = service.get_meeting(db, code)
        return service.leave_meeting(db, meeting, token)

    participant_id = await run_in_threadpool(finish)
    await manager.disconnect_participant(code, participant_id)
    return {"success": True}


@router.post("/meetings/{code}/end")
async def end(code: str, db: DB, token: Token):
    def finish():
        meeting = service.get_meeting(db, code)
        service.require_host(meeting, token)
        service.end_meeting(db, meeting)

    await run_in_threadpool(finish)
    await manager.close_room(code)
    return {"success": True}


@router.get("/rtc-config")
def rtc_config():
    return {
        "ice_servers": get_settings().ice_servers,
        "max_participants": get_settings().max_participants,
    }


@ws_router.websocket("/ws/meetings/{code}")
async def signaling(socket: WebSocket, code: str):
    await manager.handle(socket, code)
