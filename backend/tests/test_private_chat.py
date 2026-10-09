import time
from contextlib import ExitStack

import pytest
from sqlalchemy import update

from app.database import SessionLocal, utcnow
from app.models import MeetingParticipant
from test_meetings import create
from test_signaling import ORIGIN, admit, connect


def room_sockets(client, stack, created, names):
    code = created["meeting"]["meeting_code"]
    admissions, sockets = [], []
    for index, name in enumerate(names):
        admission = admit(client, created, name, index == 0)
        ws = stack.enter_context(
            client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN)
        )
        welcome = connect(ws, admission)
        assert len(welcome["participants"]) == index + 1
        assert "private-chat" in welcome["capabilities"]
        for previous in sockets:
            assert previous.receive_json()["type"] == "participant-joined"
        admissions.append(admission)
        sockets.append(ws)
    return admissions, sockets


def barrier(ws):
    ws.send_json({"type": "ping"})
    # Any leaked message would be queued before this pong.
    assert ws.receive_json() == {"type": "pong"}


def test_four_person_private_chat_excludes_host_and_other_room(client):
    one, two = create(client), create(client)
    with ExitStack() as stack:
        admissions, (host, sender, recipient, bystander) = room_sockets(
            client, stack, one, ["Host", "Alice", "Bob", "Carol"]
        )
        _, (outsider,) = room_sockets(client, stack, two, ["Other room"])
        sender.send_json({"type": "chat", "text": "Everyone"})
        group = sender.receive_json()
        assert group["chat"]["recipient_id"] is None
        assert group["chat"]["recipient_name"] is None
        for ws in [host, recipient, bystander]:
            assert ws.receive_json() == group
        time.sleep(0.51)
        sender.send_json(
            {
                "type": "chat",
                "text": "  Private to Bob  ",
                "recipient_id": admissions[2]["participant"]["id"],
                "display_name": "Forged sender",
                "participant_id": admissions[0]["participant"]["id"],
                "recipient_name": "Forged recipient",
                "meeting_id": two["meeting"]["meeting_code"],
            }
        )
        event = sender.receive_json()
        assert recipient.receive_json() == event
        assert event["chat"] | {"id": "generated", "sent_at": "UTC"} == {
            "id": "generated",
            "sent_at": "UTC",
            "participant_id": admissions[1]["participant"]["id"],
            "display_name": "Alice",
            "recipient_id": admissions[2]["participant"]["id"],
            "recipient_name": "Bob",
            "text": "Private to Bob",
        }
        for ws in [host, bystander, outsider]:
            barrier(ws)
        # One throttle covers both group and private messages.
        sender.send_json({"type": "chat", "text": "Too soon"})
        assert sender.receive_json()["code"] == "CHAT_RATE_LIMIT"
        recipient.send_json(
            {
                "type": "chat",
                "recipient_id": admissions[1]["participant"]["id"],
                "text": "x" * 2000,
            }
        )
        reply = recipient.receive_json()
        assert sender.receive_json() == reply
        assert len(reply["chat"]["text"]) == 2000
        for ws in [host, bystander, outsider]:
            barrier(ws)


@pytest.mark.parametrize("target", [True, False, "2", [], {}, 0, -1, "self"])
def test_private_chat_rejects_invalid_targets_without_broadcast(client, target):
    with ExitStack() as stack:
        admissions, (host, sender) = room_sockets(
            client, stack, create(client), ["Host", "Alice"]
        )
        sender.send_json(
            {
                "type": "chat",
                "recipient_id": admissions[1]["participant"]["id"]
                if target == "self"
                else target,
                "text": "Must not leak",
            }
        )
        assert sender.receive_json()["code"] == "INVALID_CHAT_RECIPIENT"
        barrier(host)


def test_private_chat_rejects_cross_room_unconnected_and_unknown_targets(client):
    one, two = create(client), create(client)
    with ExitStack() as stack:
        _, (host, sender) = room_sockets(client, stack, one, ["Host", "Alice"])
        outsiders, (outsider,) = room_sockets(client, stack, two, ["Outsider"])
        unconnected = admit(client, one, "Not connected")
        for target in [
            outsiders[0]["participant"]["id"],
            unconnected["participant"]["id"],
            999999,
        ]:
            sender.send_json(
                {"type": "chat", "text": "Must not leak", "recipient_id": target}
            )
            assert sender.receive_json()["code"] == "CHAT_RECIPIENT_UNAVAILABLE"
            barrier(host)
            barrier(outsider)


@pytest.mark.parametrize("field", ["left_at", "removed_at"])
def test_private_chat_rechecks_database_membership(client, field):
    with ExitStack() as stack:
        admissions, (host, sender, recipient) = room_sockets(
            client, stack, create(client), ["Host", "Alice", "Bob"]
        )
        target = admissions[2]["participant"]["id"]
        # Simulate revocation before the socket has been removed from the room map.
        with SessionLocal() as db:
            db.execute(
                update(MeetingParticipant)
                .where(MeetingParticipant.id == target)
                .values(**{field: utcnow()})
            )
            db.commit()
        sender.send_json({"type": "chat", "text": "Revoked", "recipient_id": target})
        assert sender.receive_json()["code"] == "CHAT_RECIPIENT_UNAVAILABLE"
        barrier(host)
        recipient.send_json({"type": "ping"})
        assert recipient.receive_json()["code"] == "INVALID_SESSION"


@pytest.mark.parametrize("departure", ["leave", "remove"])
def test_private_chat_never_retargets_departed_session_on_rejoin(client, departure):
    created = create(client)
    code = created["meeting"]["meeting_code"]
    with ExitStack() as stack:
        admissions, (host, sender, recipient) = room_sockets(
            client, stack, created, ["Host", "Alice", "Bob"]
        )
        old_id = admissions[2]["participant"]["id"]
        if departure == "remove":
            host.send_json({"type": "remove-participant", "target": old_id})
            assert recipient.receive_json()["type"] == "removed"
        else:
            response = client.post(
                f"/api/meetings/{code}/leave",
                headers={
                    "Authorization": "Bearer " + admissions[2]["participant_token"]
                },
            )
            assert response.status_code == 200
        for ws in [host, sender]:
            assert ws.receive_json() == {"type": "participant-left", "id": old_id}
        rejoined = admit(client, created, "Bob")
        new_id = rejoined["participant"]["id"]
        assert new_id != old_id
        replacement = stack.enter_context(
            client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN)
        )
        connect(replacement, rejoined)
        for ws in [host, sender]:
            assert ws.receive_json()["type"] == "participant-joined"
        sender.send_json({"type": "chat", "text": "Old draft", "recipient_id": old_id})
        assert sender.receive_json()["code"] == "CHAT_RECIPIENT_UNAVAILABLE"
        barrier(host)
        barrier(replacement)
        sender.send_json(
            {"type": "chat", "text": "New conversation", "recipient_id": new_id}
        )
        event = sender.receive_json()
        assert replacement.receive_json() == event
        barrier(host)


def test_private_chat_requires_an_authenticated_sender(client):
    created = create(client)
    code = created["meeting"]["meeting_code"]
    with ExitStack() as stack:
        admissions, (host,) = room_sockets(client, stack, created, ["Host"])
        unauthenticated = stack.enter_context(
            client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN)
        )
        unauthenticated.send_json(
            {
                "type": "chat",
                "text": "Before auth",
                "recipient_id": admissions[0]["participant"]["id"],
            }
        )
        assert unauthenticated.receive_json()["code"] == "INVALID_SESSION"
        barrier(host)
