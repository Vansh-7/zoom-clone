from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack

import pytest
from sqlalchemy import select

from app.config import get_settings
from app.database import SessionLocal
from app.models import Meeting, MeetingParticipant
from test_meetings import create, host_header
from test_signaling import ORIGIN, admit, connect


@pytest.mark.parametrize("capacity", [3, 4])
def test_mesh_admission_routing_controls_and_cleanup(client, monkeypatch, capacity):
    monkeypatch.setattr(get_settings(), "max_participants", capacity)
    created = create(client)
    code = created["meeting"]["meeting_code"]
    admissions = [admit(client, created, "Host", True)]

    def join(index):
        return client.post(
            f"/api/meetings/{code}/join", json={"display_name": f"Guest {index}"}
        )

    with ThreadPoolExecutor(max_workers=capacity + 1) as pool:
        responses = list(pool.map(join, range(capacity + 1)))
    admissions.extend(
        response.json() for response in responses if response.status_code == 201
    )
    assert len(admissions) == capacity
    assert sum(response.status_code == 409 for response in responses) == 2
    assert all(
        response.json()["error"]["code"] == "MEETING_FULL"
        for response in responses
        if response.status_code == 409
    )

    with ExitStack() as stack:
        sockets = []
        for admission in admissions:
            socket = stack.enter_context(
                client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN)
            )
            welcome = connect(socket, admission)
            assert len(welcome["participants"]) == len(sockets) + 1
            for previous in sockets:
                assert (
                    previous.receive_json()["participant"]["id"]
                    == admission["participant"]["id"]
                )
            sockets.append(socket)
        for i, sender in enumerate(sockets):
            for j in range(i + 1, capacity):
                target = sockets[j]
                for kind, source, receiver, source_id, target_id in [
                    (
                        "offer",
                        sender,
                        target,
                        admissions[i]["participant"]["id"],
                        admissions[j]["participant"]["id"],
                    ),
                    (
                        "answer",
                        target,
                        sender,
                        admissions[j]["participant"]["id"],
                        admissions[i]["participant"]["id"],
                    ),
                    (
                        "candidate",
                        sender,
                        target,
                        admissions[i]["participant"]["id"],
                        admissions[j]["participant"]["id"],
                    ),
                    (
                        "restart-ice",
                        target,
                        sender,
                        admissions[j]["participant"]["id"],
                        admissions[i]["participant"]["id"],
                    ),
                ]:
                    payload = (
                        {"candidate": "", "usernameFragment": "generation"}
                        if kind == "candidate"
                        else {"type": kind, "sdp": f"pair-{i}-{j}"}
                    )
                    source.send_json(
                        {
                            "type": kind,
                            "target": target_id,
                            "sender": 999,
                            "payload": payload,
                        }
                    )
                    forwarded = receiver.receive_json()
                    assert (
                        forwarded["type"] == kind and forwarded["sender"] == source_id
                    )
                    for index, other in enumerate(sockets):
                        if index not in (i, j):
                            other.send_json({"type": "ping"})
                            assert other.receive_json() == {"type": "pong"}

        for index, sender in enumerate(sockets):
            sender.send_json(
                {
                    "type": "chat",
                    "text": f"Hello from {index}",
                    "display_name": "forged",
                }
            )
            for receiver in sockets:
                chat = receiver.receive_json()["chat"]
                assert chat["participant_id"] == admissions[index]["participant"]["id"]
                assert (
                    chat["display_name"]
                    == admissions[index]["participant"]["display_name"]
                )
                assert chat["text"] == f"Hello from {index}"

        sockets[1].send_json({"type": "mute-all"})
        assert sockets[1].receive_json()["code"] == "HOST_REQUIRED"
        sockets[0].send_json({"type": "mute-all"})
        assert sockets[0].receive_json()["type"] == "notice"
        for socket in sockets[1:]:
            assert socket.receive_json()["type"] == "mute-request"

        departed = admissions[-1]
        result = client.post(
            f"/api/meetings/{code}/leave",
            headers={"Authorization": f"Bearer {departed['participant_token']}"},
        )
        assert result.status_code == 200
        for socket in sockets[:-1]:
            assert socket.receive_json() == {
                "type": "participant-left",
                "id": departed["participant"]["id"],
            }
        result = client.post(f"/api/meetings/{code}/end", headers=host_header(created))
        assert result.status_code == 200
        for socket in sockets[:-1]:
            assert socket.receive_json()["type"] == "meeting-ended"

    with SessionLocal() as db:
        meeting = db.scalar(select(Meeting).where(Meeting.meeting_code == code))
        assert meeting.status == "ended"
        participants = list(
            db.scalars(
                select(MeetingParticipant).where(
                    MeetingParticipant.meeting_id == meeting.id
                )
            )
        )
        assert len(participants) == capacity
        assert all(participant.left_at is not None for participant in participants)
