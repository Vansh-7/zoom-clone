import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import timedelta

import anyio

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy import select, update
from starlette.concurrency import run_in_threadpool

from app.config import get_settings
from app.database import SessionLocal, utcnow
from app.models import Meeting, MeetingParticipant
from app.services.meetings import AppError, end_meeting, get_meeting, token_hash
from app.websocket.limits import (
    AUTH_TIMEOUT_SECONDS,
    MAX_INVALID_MESSAGES,
    MAX_MESSAGE_BYTES,
    ConnectionGate,
    TokenBucket,
)

logger = logging.getLogger("uvicorn.error")
REACTIONS = {"clap", "thumbs_up", "laugh", "surprised", "heart", "celebrate"}


@dataclass
class Connection:
    socket: WebSocket
    id: int
    display_name: str
    role: str
    audio_enabled: bool = False
    video_enabled: bool = False
    screen_sharing: bool = False
    hand_raised: bool = False
    reactions: TokenBucket = field(default_factory=lambda: TokenBucket(1, 1))
    last_chat_at: float = 0
    messages: TokenBucket = field(default_factory=lambda: TokenBucket(160, 40))
    controls: TokenBucket = field(default_factory=lambda: TokenBucket(20, 5))
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def public(self):
        return {
            "id": self.id,
            "display_name": self.display_name,
            "role": self.role,
            "audio_enabled": self.audio_enabled,
            "video_enabled": self.video_enabled,
            "screen_sharing": self.screen_sharing,
            "hand_raised": self.hand_raised,
        }

    async def send(self, message: dict):
        async with self.lock:
            try:
                await self.socket.send_json(message)
            except (RuntimeError, WebSocketDisconnect, OSError):
                pass


def authenticate(code: str, digest: str):
    with SessionLocal() as db:
        # One fresh joined SELECT; never cache membership or authorization.
        participant = (
            db.execute(
                select(
                    MeetingParticipant.id,
                    MeetingParticipant.display_name,
                    MeetingParticipant.role,
                )
                .join(Meeting, Meeting.id == MeetingParticipant.meeting_id)
                .where(
                    Meeting.meeting_code == code,
                    Meeting.status == "in_progress",
                    MeetingParticipant.token_hash == digest,
                    MeetingParticipant.left_at.is_(None),
                    MeetingParticipant.removed_at.is_(None),
                )
            )
            .mappings()
            .one_or_none()
        )
        if participant is None:
            raise AppError(
                401,
                "INVALID_SESSION",
                "Your meeting session has ended. Please join again.",
            )
        return dict(participant)


def chat_recipient_name(code: str, participant_id: int) -> str:
    with SessionLocal() as db:
        name = db.scalar(
            select(MeetingParticipant.display_name)
            .join(Meeting, Meeting.id == MeetingParticipant.meeting_id)
            .where(
                Meeting.meeting_code == code,
                Meeting.status == "in_progress",
                MeetingParticipant.id == participant_id,
                MeetingParticipant.left_at.is_(None),
                MeetingParticipant.removed_at.is_(None),
            )
        )
        if name is None:
            raise AppError(
                409,
                "CHAT_RECIPIENT_UNAVAILABLE",
                "This participant is no longer connected. Choose another recipient.",
            )
        return name


async def receive_text(socket: WebSocket, limit: int = MAX_MESSAGE_BYTES) -> str:
    event = await socket.receive()
    if event["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(event.get("code", 1000))
    raw = event.get("text")
    if raw is None:
        await socket.close(code=1003)
        raise WebSocketDisconnect(1003)
    # Defense for direct ASGI clients; app.server enforces this before ASGI delivery.
    if len(raw.encode("utf-8")) > limit:
        await socket.close(code=1009)
        raise WebSocketDisconnect(1009)
    return raw


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
        self.gate = ConnectionGate()

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
        if len(code) != 11 or not code.isascii() or not code.isdigit():
            await socket.close(code=4403)
            return
        ip = socket.client.host if socket.client else "unknown"
        gate = self.gate
        if not gate.acquire(ip):
            await socket.close(code=1013)
            return
        connection = None
        pending = True
        host_session = False
        try:
            await socket.accept()
            auth = json.loads(
                await asyncio.wait_for(
                    receive_text(socket, 1024), timeout=AUTH_TIMEOUT_SECONDS
                )
            )
            if (
                not isinstance(auth, dict)
                or auth.get("type") != "auth"
                or not isinstance(auth.get("token"), str)
                or not 1 <= len(auth["token"]) <= 128
                or not auth["token"].isascii()
            ):
                raise AppError(
                    401, "INVALID_SESSION", "A valid participant session is required."
                )
            digest = token_hash(auth["token"])
            participant = await run_in_threadpool(authenticate, code, digest)
            room = self.rooms.setdefault(code, {})
            if participant["id"] in room:
                raise AppError(
                    409, "SESSION_CONNECTED", "This participant is already connected."
                )
            connection = Connection(socket=socket, **participant)
            room[connection.id] = connection
            gate.authenticated(ip)
            pending = False
            host_session = connection.role == "host"
            if connection.role == "host":
                timer = self.host_timers.pop(code, None)
                if timer:
                    timer.cancel()
            await connection.send(
                {
                    "type": "welcome",
                    "self_id": connection.id,
                    "capabilities": ["private-chat"],
                    "participants": [c.public() for c in room.values()],
                }
            )
            await self.broadcast(
                code,
                {"type": "participant-joined", "participant": connection.public()},
                connection.id,
            )
            invalid_messages = 0
            while True:
                raw = await receive_text(socket)
                if not connection.messages.take():
                    await connection.send(
                        {
                            "type": "error",
                            "code": "WS_RATE_LIMIT",
                            "message": "Too many signaling messages. Please rejoin.",
                        }
                    )
                    await socket.close(code=1008)
                    break
                try:
                    message = json.loads(raw)
                    if not isinstance(message, dict):
                        raise ValueError("Message must be an object")
                    kind = message.get("type")
                    if kind != "candidate" and not connection.controls.take():
                        raise AppError(
                            429,
                            "WS_RATE_LIMIT",
                            "Too many meeting commands. Please rejoin.",
                        )
                    if kind not in (
                        "ping",
                        "offer",
                        "answer",
                        "candidate",
                        "restart-ice",
                        "media-state",
                        "chat",
                        "reaction",
                        "hand-state",
                        "mute-all",
                        "remove-participant",
                    ):
                        raise ValueError("Unknown message type")
                    participant = await run_in_threadpool(authenticate, code, digest)
                    connection.role = participant["role"]
                    connection.display_name = participant["display_name"]
                    if kind == "ping":
                        await connection.send({"type": "pong"})
                        continue
                    if kind in ("offer", "answer", "candidate", "restart-ice"):
                        target_id, payload = (
                            message.get("target"),
                            message.get("payload"),
                        )
                        if (
                            type(target_id) is not int
                            or target_id == connection.id
                            or (kind != "restart-ice" and not isinstance(payload, dict))
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
                            log = logger.debug if kind == "candidate" else logger.info
                            log(
                                "rtc_signal type=%s meeting=%s sender=%s target=%s",
                                kind,
                                code,
                                connection.id,
                                target_id,
                            )
                            await target.send(
                                {
                                    "type": kind,
                                    "sender": connection.id,
                                    "payload": payload,
                                }
                            )
                        else:
                            raise AppError(
                                409,
                                "PEER_UNAVAILABLE",
                                "The other participant disconnected. Wait for them to rejoin.",
                            )
                    elif kind == "media-state":
                        if not isinstance(
                            message.get("audio_enabled"), bool
                        ) or not isinstance(message.get("video_enabled"), bool):
                            raise ValueError("Media state must use booleans")
                        sharing = message.get("screen_sharing", False)
                        if not isinstance(sharing, bool):
                            raise ValueError("Screen sharing state must use a boolean")
                        connection.audio_enabled = message["audio_enabled"]
                        connection.video_enabled = message["video_enabled"]
                        connection.screen_sharing = sharing
                        await self.broadcast(
                            code,
                            {"type": "media-state", "participant": connection.public()},
                        )
                    elif kind == "reaction":
                        reaction = message.get("reaction")
                        if not isinstance(reaction, str) or reaction not in REACTIONS:
                            raise AppError(
                                422, "INVALID_REACTION", "Choose a supported reaction."
                            )
                        if not connection.reactions.take():
                            raise AppError(
                                429,
                                "REACTION_RATE_LIMIT",
                                "Please wait before reacting again.",
                            )
                        await self.broadcast(
                            code,
                            {
                                "type": "reaction",
                                "participant_id": connection.id,
                                "reaction": reaction,
                                "id": uuid.uuid4().hex,
                                "expires_at": (
                                    utcnow() + timedelta(seconds=4)
                                ).isoformat(),
                            },
                        )
                    elif kind == "hand-state":
                        if type(message.get("raised")) is not bool:
                            raise AppError(
                                422,
                                "INVALID_HAND_STATE",
                                "Raised hand must use a boolean.",
                            )
                        connection.hand_raised = message["raised"]
                        await self.broadcast(
                            code,
                            {"type": "hand-state", "participant": connection.public()},
                        )
                    elif kind == "chat":
                        text = message.get("text")
                        if (
                            not isinstance(text, str)
                            or not 1 <= len(text.strip()) <= 2000
                        ):
                            raise AppError(
                                422,
                                "INVALID_CHAT",
                                "Messages must contain 1–2000 characters.",
                            )
                        recipient_id = message.get("recipient_id")
                        recipient = None
                        recipient_name = None
                        if recipient_id is not None:
                            if (
                                type(recipient_id) is not int
                                or recipient_id <= 0
                                or recipient_id == connection.id
                            ):
                                raise AppError(
                                    422,
                                    "INVALID_CHAT_RECIPIENT",
                                    "Choose another participant or Everyone.",
                                )
                            recipient = self.rooms.get(code, {}).get(recipient_id)
                            if recipient is None:
                                raise AppError(
                                    409,
                                    "CHAT_RECIPIENT_UNAVAILABLE",
                                    "This participant is no longer connected. Choose another recipient.",
                                )
                            recipient_name = await run_in_threadpool(
                                chat_recipient_name, code, recipient_id
                            )
                            # A leave/removal may have completed during the database check.
                            # Never fall back to a broadcast or a different session.
                            if (
                                self.rooms.get(code, {}).get(recipient_id)
                                is not recipient
                            ):
                                raise AppError(
                                    409,
                                    "CHAT_RECIPIENT_UNAVAILABLE",
                                    "This participant is no longer connected. Choose another recipient.",
                                )
                        if time.monotonic() - connection.last_chat_at < 0.5:
                            raise AppError(
                                429,
                                "CHAT_RATE_LIMIT",
                                "Please wait a moment before sending another message.",
                            )
                        connection.last_chat_at = time.monotonic()
                        event = {
                            "type": "chat",
                            "chat": {
                                "id": uuid.uuid4().hex,
                                "participant_id": connection.id,
                                "display_name": connection.display_name,
                                "recipient_id": recipient_id,
                                "recipient_name": recipient_name,
                                "text": text.strip(),
                                "sent_at": utcnow().isoformat(),
                            },
                        }
                        if recipient is None:
                            await self.broadcast(code, event)
                        else:
                            await asyncio.gather(
                                connection.send(event), recipient.send(event)
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
                            if type(target_id) is not int:
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
                except (ValueError, RecursionError, AppError) as exc:
                    logger.warning(
                        "rtc_signal_rejected meeting=%s participant=%s code=%s",
                        code,
                        connection.id,
                        getattr(exc, "code", "INVALID_MESSAGE"),
                    )
                    await connection.send(
                        {
                            "type": "error",
                            "code": getattr(exc, "code", "INVALID_MESSAGE"),
                            "message": getattr(exc, "message", str(exc)),
                        }
                    )
                    if getattr(exc, "status", None) == 401:
                        await socket.close(code=4401)
                        break
                    if getattr(exc, "code", None) == "WS_RATE_LIMIT":
                        await socket.close(code=1008)
                        break
                    if (
                        isinstance(exc, (ValueError, RecursionError))
                        or getattr(exc, "code", None) == "HOST_REQUIRED"
                    ):
                        invalid_messages += 1
                        if invalid_messages >= MAX_INVALID_MESSAGES:
                            await socket.close(code=1008)
                            break
        except AppError as exc:
            await socket.send_json(
                {"type": "error", "code": exc.code, "message": exc.message}
            )
            await socket.close(code=4401)
        except asyncio.TimeoutError:
            await socket.close(code=1008)
        except (
            WebSocketDisconnect,
            ValueError,
            RecursionError,
            RuntimeError,
            OSError,
        ):
            if connection is None:
                try:
                    await socket.close(code=1008)
                except (RuntimeError, OSError):
                    pass
        finally:
            gate.release(ip, pending)
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
                    if host_session:
                        previous = self.host_timers.pop(code, None)
                        if previous:
                            previous.cancel()
                        self.host_timers[code] = asyncio.create_task(
                            self.expire_host(code)
                        )


manager = RoomManager()
