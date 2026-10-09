from contextlib import ExitStack
from datetime import datetime

import pytest
from sqlalchemy import update

from app.database import SessionLocal, utcnow
from app.models import MeetingParticipant
from app.websocket.manager import REACTIONS, manager
from test_meetings import create
from test_signaling import ORIGIN, admit, connect


def socket(client, stack, created, admission):
    ws = stack.enter_context(
        client.websocket_connect(
            f"/ws/meetings/{created['meeting']['meeting_code']}", headers=ORIGIN
        )
    )
    return ws, connect(ws, admission)


def test_reaction_identity_throttle_validation_and_room_isolation(client):
    one, two = create(client), create(client)
    host = admit(client, one, "Host", True)
    guest = admit(client, one, "Guest")
    other = admit(client, two, "Other", True)
    with ExitStack() as stack:
        a, _ = socket(client, stack, one, host)
        b, _ = socket(client, stack, one, guest)
        c, _ = socket(client, stack, two, other)
        assert a.receive_json()["type"] == "participant-joined"
        for invalid in [None, 42, {}, "<script>"]:
            b.send_json({"type": "reaction", "reaction": invalid})
            assert b.receive_json()["code"] == "INVALID_REACTION"
        for reaction in REACTIONS:
            manager.rooms[one["meeting"]["meeting_code"]][
                guest["participant"]["id"]
            ].reactions.tokens = 1
            b.send_json(
                {"type": "reaction", "reaction": reaction, "participant_id": 999}
            )
            event = b.receive_json()
            assert a.receive_json() == event
            assert event["participant_id"] == guest["participant"]["id"]
            assert event["reaction"] == reaction
            assert len(event["id"]) == 32
            assert (
                3
                < (
                    datetime.fromisoformat(event["expires_at"]) - utcnow()
                ).total_seconds()
                <= 4
            )
        b.send_json({"type": "reaction", "reaction": "heart"})
        assert b.receive_json()["code"] == "REACTION_RATE_LIMIT"
        c.send_json({"type": "ping"})
        assert c.receive_json() == {"type": "pong"}


def test_raised_hand_is_authoritative_for_late_joiners_and_clears_on_departure(client):
    created = create(client)
    host, guest = admit(client, created, "Host", True), admit(client, created, "Guest")
    with ExitStack() as stack:
        a, _ = socket(client, stack, created, host)
        b, _ = socket(client, stack, created, guest)
        a.receive_json()
        for invalid in [None, "true", 1]:
            b.send_json({"type": "hand-state", "raised": invalid})
            assert b.receive_json()["code"] == "INVALID_HAND_STATE"
        b.send_json(
            {
                "type": "hand-state",
                "raised": True,
                "participant_id": host["participant"]["id"],
            }
        )
        event = b.receive_json()
        assert a.receive_json() == event
        assert event["participant"]["id"] == guest["participant"]["id"]
        assert event["participant"]["hand_raised"] is True
        late = admit(client, created, "Late")
        c, welcome = socket(client, stack, created, late)
        assert (
            next(
                item
                for item in welcome["participants"]
                if item["id"] == guest["participant"]["id"]
            )["hand_raised"]
            is True
        )
        a.receive_json()
        b.receive_json()
        b.send_json({"type": "hand-state", "raised": False})
        assert all(
            ws.receive_json()["participant"]["hand_raised"] is False for ws in [a, b, c]
        )
        b.send_json({"type": "hand-state", "raised": True})
        for ws in [a, b, c]:
            ws.receive_json()
        b.close()
        assert a.receive_json() == {
            "type": "participant-left",
            "id": guest["participant"]["id"],
        }
        assert c.receive_json()["type"] == "participant-left"
        c.send_json({"type": "ping"})
        assert c.receive_json()["type"] == "pong"
        assert (
            guest["participant"]["id"]
            not in manager.rooms[created["meeting"]["meeting_code"]]
        )


@pytest.mark.parametrize(
    "message",
    [{"type": "reaction", "reaction": "clap"}, {"type": "hand-state", "raised": True}],
)
def test_revoked_participant_cannot_react_or_raise_hand(client, message):
    created = create(client)
    guest = admit(client, created, "Guest")
    with ExitStack() as stack:
        ws, _ = socket(client, stack, created, guest)
        with SessionLocal() as db:
            db.execute(
                update(MeetingParticipant)
                .where(MeetingParticipant.id == guest["participant"]["id"])
                .values(removed_at=utcnow())
            )
            db.commit()
        ws.send_json(message)
        assert ws.receive_json()["code"] == "INVALID_SESSION"


@pytest.mark.parametrize(
    "message",
    [{"type": "reaction", "reaction": "clap"}, {"type": "hand-state", "raised": True}],
)
def test_reaction_requires_authentication(client, message):
    created = create(client)
    with client.websocket_connect(
        f"/ws/meetings/{created['meeting']['meeting_code']}", headers=ORIGIN
    ) as ws:
        ws.send_json(message)
        assert ws.receive_json()["code"] == "INVALID_SESSION"


@pytest.mark.parametrize("action", ["remove", "end"])
def test_raised_hand_clears_on_removal_and_end(client, action):
    created = create(client)
    code = created["meeting"]["meeting_code"]
    host, guest = admit(client, created, "Host", True), admit(client, created, "Guest")
    with ExitStack() as stack:
        a, _ = socket(client, stack, created, host)
        b, _ = socket(client, stack, created, guest)
        a.receive_json()
        b.send_json({"type": "hand-state", "raised": True})
        assert a.receive_json()["participant"]["hand_raised"] is True
        b.receive_json()
        if action == "remove":
            a.send_json(
                {"type": "remove-participant", "target": guest["participant"]["id"]}
            )
            assert b.receive_json()["type"] == "removed"
            assert a.receive_json()["type"] == "participant-left"
            assert guest["participant"]["id"] not in manager.rooms[code]
        else:
            response = client.post(
                f"/api/meetings/{code}/end",
                headers={"Authorization": f"Bearer {created['host_token']}"},
            )
            assert response.status_code == 200
            assert (
                a.receive_json()["type"] == b.receive_json()["type"] == "meeting-ended"
            )
    assert code not in manager.rooms
