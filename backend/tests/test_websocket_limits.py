from contextlib import ExitStack

import pytest
from sqlalchemy import event, update
from starlette.websockets import WebSocketDisconnect

from app.database import SessionLocal, engine, utcnow
from app.models import Meeting, MeetingParticipant
from app.services.meetings import token_hash
from app.websocket import manager as module
from app.websocket.limits import ConnectionGate, MAX_INVALID_MESSAGES, TokenBucket
from app.websocket.manager import authenticate, manager
from test_meetings import create
from test_signaling import ORIGIN, admit, connect


def test_token_bucket_refill_and_connection_bounds():
    bucket = TokenBucket(3, 2, updated_at=0)
    assert all(bucket.take(0) for _ in range(3))
    assert not bucket.take(0.49)
    assert bucket.take(0.5)
    assert not bucket.take(0.5)
    gate = ConnectionGate(total_limit=3, pending_limit=2, per_ip_pending_limit=1)
    assert gate.acquire("one")
    assert not gate.acquire("one")
    assert gate.acquire("two")
    assert not gate.acquire("three")
    gate.authenticated("one")
    assert gate.acquire("three")
    gate.authenticated("two")
    gate.authenticated("three")
    assert not gate.acquire("four")
    for ip in ("one", "two", "three"):
        gate.release(ip, pending=False)
    assert (gate.total, gate.pending, gate.pending_by_ip) == (0, 0, {})


def test_global_attempt_limit_and_bounded_peer_tracking():
    gate = ConnectionGate()
    gate.attempts = TokenBucket(3, 0)
    for i in range(3):
        assert gate.acquire(str(i))
        gate.release(str(i), pending=True)
    assert not gate.acquire("another")
    gate.attempts = TokenBucket(1100, 0)
    for i in range(1100):
        assert gate.acquire(str(i))
        gate.release(str(i), pending=True)
    assert len(gate.attempts_by_ip) == 1024


@pytest.mark.parametrize("command", ["mute-all", "remove-participant"])
def test_one_joined_select_per_check_and_fresh_authorization(client, command):
    created = create(client)
    code = created["meeting"]["meeting_code"]
    admission = admit(client, created, "Host", True)
    statements = []

    def record(_conn, _cursor, statement, *_args):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        assert (
            authenticate(code, token_hash(admission["participant_token"]))["role"]
            == "host"
        )
        assert len(statements) == 1
        assert "JOIN meetings" in statements[0]
        statements.clear()
        with client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN) as ws:
            connect(ws, admission)
            assert len(statements) == 1
            statements.clear()
            ws.send_json({"type": "ping"})
            assert ws.receive_json() == {"type": "pong"}
            assert len(statements) == 1
            with SessionLocal() as db:
                db.execute(
                    update(MeetingParticipant)
                    .where(MeetingParticipant.id == admission["participant"]["id"])
                    .values(role="guest")
                )
                db.commit()
            statements.clear()
            ws.send_json({"type": command, "target": 999})
            assert ws.receive_json()["code"] == "HOST_REQUIRED"
            assert len(statements) == 1
    finally:
        event.remove(engine, "before_cursor_execute", record)


@pytest.mark.parametrize("revocation", ["left", "removed", "token", "ended"])
def test_connected_session_revoked_in_database_is_closed(client, revocation):
    created = create(client)
    code = created["meeting"]["meeting_code"]
    admission = admit(client, created, "Host", True)
    with client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN) as ws:
        connect(ws, admission)
        with SessionLocal() as db:
            if revocation == "ended":
                db.execute(
                    update(Meeting)
                    .where(Meeting.meeting_code == code)
                    .values(status="ended")
                )
            else:
                values = {
                    "left": {"left_at": utcnow()},
                    "removed": {"removed_at": utcnow()},
                    "token": {"token_hash": token_hash("replacement")},
                }[revocation]
                db.execute(
                    update(MeetingParticipant)
                    .where(MeetingParticipant.id == admission["participant"]["id"])
                    .values(**values)
                )
            db.commit()
        # Heartbeats also revalidate, so a revoked idle session cannot stay alive.
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["code"] == "INVALID_SESSION"
        with pytest.raises(WebSocketDisconnect) as error:
            ws.receive_json()
        assert error.value.code == 4401


def test_cross_room_token_and_duplicate_socket_rejected(client):
    one, two = create(client), create(client)
    code = one["meeting"]["meeting_code"]
    host = admit(client, one, "Host", True)
    other = admit(client, two, "Other", True)
    with client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN) as ws:
        ws.send_json({"type": "auth", "token": other["participant_token"]})
        assert ws.receive_json()["code"] == "INVALID_SESSION"
    with client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN) as ws:
        connect(ws, host)
        with client.websocket_connect(
            f"/ws/meetings/{code}", headers=ORIGIN
        ) as duplicate:
            duplicate.send_json({"type": "auth", "token": host["participant_token"]})
            assert duplicate.receive_json()["code"] == "SESSION_CONNECTED"
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"


def test_ice_burst_forwarded_then_excess_closed(client):
    created = create(client)
    code = created["meeting"]["meeting_code"]
    host, guest = admit(client, created, "Host", True), admit(client, created, "Guest")
    with ExitStack() as stack:
        host_ws, guest_ws = [
            stack.enter_context(
                client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN)
            )
            for _ in range(2)
        ]
        connect(host_ws, host)
        connect(guest_ws, guest)
        assert host_ws.receive_json()["type"] == "participant-joined"
        candidate = {
            "type": "candidate",
            "target": guest["participant"]["id"],
            "payload": {
                "candidate": "candidate:test",
                "usernameFragment": "generation",
            },
            "sender": 999,
        }
        for _ in range(120):
            host_ws.send_json(candidate)
            received = guest_ws.receive_json()
            assert received["type"] == "candidate"
            assert received["sender"] == host["participant"]["id"]
        client.portal.call(
            lambda: setattr(
                manager.rooms[code][host["participant"]["id"]],
                "messages",
                TokenBucket(2, 0),
            )
        )
        for _ in range(2):
            host_ws.send_json(candidate)
            assert guest_ws.receive_json()["type"] == "candidate"
        host_ws.send_json(candidate)
        assert host_ws.receive_json()["code"] == "WS_RATE_LIMIT"
        with pytest.raises(WebSocketDisconnect) as error:
            host_ws.receive_json()
        assert error.value.code == 1008
        assert guest_ws.receive_json()["type"] == "participant-left"


def test_control_rate_limit_applies_to_ping(client):
    created = create(client)
    code = created["meeting"]["meeting_code"]
    host = admit(client, created, "Host", True)
    with client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN) as ws:
        connect(ws, host)
        client.portal.call(
            lambda: setattr(
                manager.rooms[code][host["participant"]["id"]],
                "controls",
                TokenBucket(2, 0),
            )
        )
        for _ in range(2):
            ws.send_json({"type": "ping"})
            assert ws.receive_json()["type"] == "pong"
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["code"] == "WS_RATE_LIMIT"
        with pytest.raises(WebSocketDisconnect) as error:
            ws.receive_json()
        assert error.value.code == 1008


def test_malformed_message_spam_closed_without_database_queries(client, monkeypatch):
    created = create(client)
    code = created["meeting"]["meeting_code"]
    admission = admit(client, created, "Host", True)
    with client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN) as ws:
        connect(ws, admission)
        monkeypatch.setattr(
            module,
            "authenticate",
            lambda *_: pytest.fail("Malformed messages must not query membership"),
        )
        for _ in range(MAX_INVALID_MESSAGES):
            ws.send_text("{")
            assert ws.receive_json()["code"] == "INVALID_MESSAGE"
        with pytest.raises(WebSocketDisconnect) as error:
            ws.receive_json()
        assert error.value.code == 1008


def test_pending_connection_bound_timeout_and_slot_cleanup(client, monkeypatch):
    created = create(client)
    code = created["meeting"]["meeting_code"]
    host = admit(client, created, "Host", True)
    monkeypatch.setattr(manager, "gate", ConnectionGate(per_ip_pending_limit=1))
    monkeypatch.setattr(module, "AUTH_TIMEOUT_SECONDS", 0.1)
    with client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN) as slow:
        with pytest.raises(WebSocketDisconnect) as rejected:
            with client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN):
                pass
        assert rejected.value.code == 1013
        with pytest.raises(WebSocketDisconnect) as timed_out:
            slow.receive_json()
        assert timed_out.value.code == 1008
    assert manager.gate.total == manager.gate.pending == 0
    with client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN) as ws:
        connect(ws, host)
        assert manager.gate.pending == 0 and manager.gate.total == 1
    assert manager.gate.total == 0


def test_repeated_forged_handshakes_limited_before_authentication(client, monkeypatch):
    created = create(client)
    code = created["meeting"]["meeting_code"]
    manager.gate.attempts = TokenBucket(2, 0)
    for _ in range(2):
        with client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN) as ws:
            ws.send_json({"type": "auth", "token": "forged"})
            assert ws.receive_json()["code"] == "INVALID_SESSION"
    monkeypatch.setattr(
        module,
        "authenticate",
        lambda *_: pytest.fail(
            "Connection must be rejected before querying the database"
        ),
    )
    with pytest.raises(WebSocketDisconnect) as error:
        with client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN):
            pass
    assert error.value.code == 1013
    assert manager.gate.total == manager.gate.pending == 0


@pytest.mark.parametrize("encoding,expected", [("text", 1009), ("binary", 1003)])
def test_authentication_frame_bound_without_database_access(
    client, monkeypatch, encoding, expected
):
    code = create(client)["meeting"]["meeting_code"]
    monkeypatch.setattr(
        module,
        "authenticate",
        lambda *_: pytest.fail("Invalid auth frames must not query the database"),
    )
    with client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN) as ws:
        if encoding == "text":
            ws.send_text("x" * 1025)
        else:
            ws.send_bytes(b"invalid")
        with pytest.raises(WebSocketDisconnect) as error:
            ws.receive_json()
        assert error.value.code == expected
    assert manager.gate.total == manager.gate.pending == 0
