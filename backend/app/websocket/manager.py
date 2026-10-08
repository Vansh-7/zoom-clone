import asyncio
import json
from dataclasses import dataclass, field

import anyio

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy import select, update
from starlette.concurrency import run_in_threadpool

from app.config import get_settings
from app.database import SessionLocal, utcnow
from app.models import Meeting, MeetingParticipant
from app.services.meetings import AppError, end_meeting, get_meeting, get_participant


@dataclass
class Connection:
    socket: WebSocket
    id: int
    display_name: str
    role: str
    audio_enabled: bool = False
    video_enabled: bool = False
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def public(self):
        return {
            "id": self.id,
            "display_name": self.display_name,
            "role": self.role,
            "audio_enabled": self.audio_enabled,
            "video_enabled": self.video_enabled,
        }

    async def send(self, message: dict):
        async with self.lock:
            try:
                await self.socket.send_json(message)
            except (RuntimeError, WebSocketDisconnect, OSError):
                pass


def authenticate(code: str, token: str):
    with SessionLocal() as db:
        meeting = get_meeting(db, code)
        participant = get_participant(db, meeting, token)
        return {
            "id": participant.id,
            "display_name": participant.display_name,
            "role": participant.role,
        }


def depart(participant_id: int):
    with SessionLocal() as db:
        db.execute(
            update(MeetingParticipant)
            .where(
                MeetingParticipant.id == participant_id,
                MeetingParticipant.left_at.is_(None),
            )
            .values(left_at=utcnow())
        )
        db.commit()


def remove_participant(code: str, target: int):
    with SessionLocal() as db:
        meeting = get_meeting(db, code)
        participant = db.get(MeetingParticipant, target)
        if (
            not participant
            or participant.meeting_id != meeting.id
            or participant.role == "host"
        ):
            raise AppError(
                403, "INVALID_TARGET", "Only guests in this room can be removed."
            )
        participant.removed_at = participant.left_at = utcnow()
        db.commit()


class RoomManager:
    def __init__(self):
        self.rooms: dict[str, dict[int, Connection]] = {}
        self.host_timers: dict[str, asyncio.Task] = {}

    async def broadcast(self, code: str, message: dict, exclude: int | None = None):
        connections = list(self.rooms.get(code, {}).values())
        await asyncio.gather(*(c.send(message) for c in connections if c.id != exclude))

    async def disconnect_participant(self, code: str, participant_id: int):
        connection = self.rooms.get(code, {}).pop(participant_id, None)
        if connection:
            await self.broadcast(
                code, {"type": "participant-left", "id": participant_id}
            )
            try:
                await connection.socket.close(code=1000)
            except (RuntimeError, OSError):
                pass

    async def close_room(self, code: str):
        timer = self.host_timers.pop(code, None)
        if timer and timer is not asyncio.current_task():
            timer.cancel()
        connections = list(self.rooms.get(code, {}).values())
        await self.broadcast(code, {"type": "meeting-ended"})
        for connection in connections:
            try:
                await connection.socket.close(code=1000)
            except (RuntimeError, OSError):
                pass

    async def expire_host(self, code: str):
        await asyncio.sleep(get_settings().disconnect_grace_seconds)
        if any(c.role == "host" for c in self.rooms.get(code, {}).values()):
            return

        def finish():
            with SessionLocal() as db:
                meeting = db.scalar(select(Meeting).where(Meeting.meeting_code == code))
                if meeting:
                    end_meeting(db, meeting)

        await run_in_threadpool(finish)
        await self.close_room(code)

    async def shutdown(self):
        for task in self.host_timers.values():
            task.cancel()
        for code in list(self.rooms):
            await self.close_room(code)
        self.host_timers.clear()

    async def handle(self, socket: WebSocket, code: str):
        if (
            socket.headers.get("origin", "").rstrip("/")
            not in get_settings().allowed_origins
        ):
            await socket.close(code=4403)
            return
        await socket.accept()
        connection = None
        try:
            auth = await asyncio.wait_for(socket.receive_json(), timeout=5)
            if (
                not isinstance(auth, dict)
                or auth.get("type") != "auth"
                or not isinstance(auth.get("token"), str)
            ):
                raise AppError(
                    401, "INVALID_SESSION", "A valid participant session is required."
                )
            participant = await run_in_threadpool(authenticate, code, auth["token"])
            room = self.rooms.setdefault(code, {})
            if participant["id"] in room:
                raise AppError(
                    409, "SESSION_CONNECTED", "This participant is already connected."
                )
            connection = Connection(socket=socket, **participant)
            room[connection.id] = connection
            if connection.role == "host":
                timer = self.host_timers.pop(code, None)
                if timer:
                    timer.cancel()
            await connection.send(
                {
                    "type": "welcome",
                    "self_id": connection.id,
                    "participants": [c.public() for c in room.values()],
                }
            )
            await self.broadcast(
                code,
                {"type": "participant-joined", "participant": connection.public()},
                connection.id,
            )
            while True:
                raw = await socket.receive_text()
                if len(raw) > 65536:
                    await socket.close(code=1009)
                    break
                try:
                    message = json.loads(raw)
                    if not isinstance(message, dict):
                        raise ValueError("Message must be an object")
                    kind = message.get("type")
                    if kind == "ping":
                        await connection.send({"type": "pong"})
                        continue
                    # Revalidate persisted membership before every meaningful command.
                    await run_in_threadpool(authenticate, code, auth["token"])
                    if kind in ("offer", "answer", "candidate"):
                        target_id, payload = (
                            message.get("target"),
                            message.get("payload"),
                        )
                        if (
                            not isinstance(target_id, int)
                            or target_id == connection.id
                            or not isinstance(payload, dict)
                        ):
                            raise ValueError("Invalid signaling target or payload")
                        if kind in ("offer", "answer") and (
                            payload.get("type") != kind
                            or not isinstance(payload.get("sdp"), str)
                        ):
                            raise ValueError("Invalid session description")
                        if kind == "candidate" and not isinstance(
                            payload.get("candidate"), str
                        ):
                            raise ValueError("Invalid ICE candidate")
                        target = self.rooms.get(code, {}).get(target_id)
                        if target:
                            await target.send(
                                {
                                    "type": kind,
                                    "sender": connection.id,
                                    "payload": payload,
                                }
                            )
                    elif kind == "media-state":
                        if not isinstance(
                            message.get("audio_enabled"), bool
                        ) or not isinstance(message.get("video_enabled"), bool):
                            raise ValueError("Media state must use booleans")
                        connection.audio_enabled = message["audio_enabled"]
                        connection.video_enabled = message["video_enabled"]
                        await self.broadcast(
                            code,
                            {"type": "media-state", "participant": connection.public()},
                        )
                    elif kind in ("mute-all", "remove-participant"):
                        if connection.role != "host":
                            raise AppError(
                                403,
                                "HOST_REQUIRED",
                                "Only the host can manage participants.",
                            )
                        if kind == "mute-all":
                            await self.broadcast(
                                code, {"type": "mute-request"}, connection.id
                            )
                            await connection.send(
                                {
                                    "type": "notice",
                                    "message": "Mute request sent to all participants.",
                                }
                            )
                        else:
                            target_id = message.get("target")
                            if not isinstance(target_id, int):
                                raise ValueError("Choose a participant to remove")
                            await run_in_threadpool(remove_participant, code, target_id)
                            target = self.rooms.get(code, {}).get(target_id)
                            if target:
                                await target.send({"type": "removed"})
                                self.rooms.get(code, {}).pop(target_id, None)
                                await self.broadcast(
                                    code, {"type": "participant-left", "id": target_id}
                                )
                                await target.socket.close(code=4403)
                    else:
                        raise ValueError("Unknown message type")
                except (ValueError, AppError) as exc:
                    await connection.send(
                        {
                            "type": "error",
                            "code": getattr(exc, "code", "INVALID_MESSAGE"),
                            "message": getattr(exc, "message", str(exc)),
                        }
                    )
        except AppError as exc:
            await socket.send_json(
                {"type": "error", "code": exc.code, "message": exc.message}
            )
            await socket.close(code=4401)
        except (
            WebSocketDisconnect,
            asyncio.TimeoutError,
            ValueError,
            RuntimeError,
            OSError,
        ):
            pass
        finally:
            if connection:
                # Finish persistence and roster cleanup even when the ASGI task is cancelled.
                with anyio.CancelScope(shield=True):
                    room = self.rooms.get(code, {})
                    present = room.pop(connection.id, None)
                    await run_in_threadpool(depart, connection.id)
                    if present:
                        await self.broadcast(
                            code, {"type": "participant-left", "id": connection.id}
                        )
                    if not room:
                        self.rooms.pop(code, None)
                    if connection.role == "host":
                        previous = self.host_timers.pop(code, None)
                        if previous:
                            previous.cancel()
                        self.host_timers[code] = asyncio.create_task(
                            self.expire_host(code)
                        )


manager = RoomManager()
