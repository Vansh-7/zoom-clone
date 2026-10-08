import time

from starlette.websockets import WebSocketDisconnect
import pytest

from app.websocket.manager import manager
from test_meetings import create, host_header

ORIGIN = {"origin": "http://localhost:3000"}


def admit(client, created, name, host=False):
    code = created["meeting"]["meeting_code"]
    response = client.post(
        f"/api/meetings/{code}/join",
        json={"display_name": name},
        headers=host_header(created) if host else {},
    )
    assert response.status_code == 201
    return response.json()


def connect(ws, admission):
    ws.send_json({"type": "auth", "token": admission["participant_token"]})
    welcome = ws.receive_json()
    assert welcome["type"] == "welcome"
    return welcome


def test_ws_auth_and_origin(client):
    created = create(client)
    code = created["meeting"]["meeting_code"]
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            f"/ws/meetings/{code}", headers={"origin": "https://evil.example"}
        ):
            pass
    with client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN) as ws:
        ws.send_json({"type": "auth", "token": "forged"})
        assert ws.receive_json()["code"] == "INVALID_SESSION"


def test_signaling_roster_host_controls_and_revocation(client):
    created = create(client)
    code = created["meeting"]["meeting_code"]
    host, guest = admit(client, created, "Alex", True), admit(client, created, "Taylor")
    with client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN) as host_ws:
        connect(host_ws, host)
        with client.websocket_connect(
            f"/ws/meetings/{code}", headers=ORIGIN
        ) as guest_ws:
            assert len(connect(guest_ws, guest)["participants"]) == 2
            assert host_ws.receive_json()["type"] == "participant-joined"
            guest_ws.send_json(
                {"type": "restart-ice", "target": host["participant"]["id"]}
            )
            assert host_ws.receive_json()["type"] == "restart-ice"
            host_ws.send_json(
                {
                    "type": "candidate",
                    "target": guest["participant"]["id"],
                    "payload": {"candidate": "", "usernameFragment": "test-generation"},
                }
            )
            assert guest_ws.receive_json()["payload"] == {
                "candidate": "",
                "usernameFragment": "test-generation",
            }
            host_ws.send_json(
                {
                    "type": "offer",
                    "target": guest["participant"]["id"],
                    "payload": {"type": "offer", "sdp": "test-sdp"},
                    "sender": 999,
                }
            )
            offer = guest_ws.receive_json()
            assert offer["sender"] == host["participant"]["id"]
            guest_ws.send_json(
                {
                    "type": "answer",
                    "target": host["participant"]["id"],
                    "payload": {"type": "answer", "sdp": "answer"},
                }
            )
            assert host_ws.receive_json()["type"] == "answer"
            guest_ws.send_json({"type": "mute-all"})
            assert guest_ws.receive_json()["code"] == "HOST_REQUIRED"
            host_ws.send_json({"type": "mute-all"})
            assert guest_ws.receive_json()["type"] == "mute-request"
            assert host_ws.receive_json()["type"] == "notice"
            guest_ws.send_json(
                {
                    "type": "media-state",
                    "audio_enabled": False,
                    "video_enabled": True,
                    "screen_sharing": True,
                }
            )
            state = guest_ws.receive_json()["participant"]
            assert state["video_enabled"] is True and state["screen_sharing"] is True
            assert host_ws.receive_json()["type"] == "media-state"
            guest_ws.send_json(
                {
                    "type": "media-state",
                    "audio_enabled": False,
                    "video_enabled": True,
                    "screen_sharing": "yes",
                }
            )
            assert guest_ws.receive_json()["code"] == "INVALID_MESSAGE"
            host_ws.send_json(
                {"type": "remove-participant", "target": guest["participant"]["id"]}
            )
            assert guest_ws.receive_json()["type"] == "removed"
        assert host_ws.receive_json()["type"] == "participant-left"
    with client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN) as ws:
        ws.send_json({"type": "auth", "token": guest["participant_token"]})
        assert ws.receive_json()["code"] == "INVALID_SESSION"


def test_rest_leave_closes_signaling_before_browser_navigation(client):
    created = create(client)
    code = created["meeting"]["meeting_code"]
    host, guest = admit(client, created, "Host", True), admit(client, created, "Guest")
    with client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN) as host_ws:
        connect(host_ws, host)
        with client.websocket_connect(
            f"/ws/meetings/{code}", headers=ORIGIN
        ) as guest_ws:
            connect(guest_ws, guest)
            assert host_ws.receive_json()["type"] == "participant-joined"
            response = client.post(
                f"/api/meetings/{code}/leave",
                headers={"Authorization": "Bearer " + guest["participant_token"]},
            )
            assert response.status_code == 200
            assert guest["participant"]["id"] not in manager.rooms[code]
            assert host_ws.receive_json() == {
                "type": "participant-left",
                "id": guest["participant"]["id"],
            }
            with pytest.raises(WebSocketDisconnect):
                guest_ws.receive_json()
        with client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN) as ws:
            ws.send_json({"type": "auth", "token": guest["participant_token"]})
            assert ws.receive_json()["code"] == "INVALID_SESSION"


def test_room_isolation_and_unexpected_departure(client):
    one, two = create(client), create(client)
    code = one["meeting"]["meeting_code"]
    host = admit(client, one, "Host", True)
    other = admit(client, two, "Other", True)
    with client.websocket_connect(f"/ws/meetings/{code}", headers=ORIGIN) as ws:
        connect(ws, host)
        ws.send_json(
            {
                "type": "offer",
                "target": other["participant"]["id"],
                "payload": {"type": "offer", "sdp": "isolated"},
            }
        )
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["code"] == "PEER_UNAVAILABLE"
        assert ws.receive_json()["type"] == "pong"
    time.sleep(0.1)
    assert client.get(f"/api/meetings/{code}").json()["status"] == "ended"
