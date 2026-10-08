import json
import socket
import threading
import time

import pytest
import uvicorn
from starlette.websockets import WebSocket
from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect as websocket_connect

from app.server import server_config
from app.websocket.limits import MAX_MESSAGE_BYTES
from test_meetings import create
from test_signaling import admit


@pytest.fixture
def live_server(client):
    # Keep TestClient's initialized database; only this thread owns network traffic.
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        config = server_config("127.0.0.1", listener.getsockname()[1])
        config.lifespan = "off"
        config.log_level = "critical"
        server = uvicorn.Server(config)
        thread = threading.Thread(
            target=server.run, kwargs={"sockets": [listener]}, daemon=True
        )
        thread.start()
        try:
            deadline = time.monotonic() + 5
            while not server.started:
                if not thread.is_alive() or time.monotonic() > deadline:
                    pytest.fail("Bounded WebSocket server did not start")
                time.sleep(0.01)
            yield f"ws://127.0.0.1:{config.port}"
        finally:
            server.should_exit = True
            thread.join(timeout=10)
            assert not thread.is_alive()


@pytest.mark.parametrize(
    "authenticated,encoding",
    [(False, "text"), (True, "text"), (True, "fragmented"), (True, "binary")],
)
def test_transport_rejects_oversized_messages_before_asgi_delivery(
    client, live_server, monkeypatch, authenticated, encoding
):
    created = create(client)
    code = created["meeting"]["meeting_code"]
    admission = admit(client, created, "Host", True)
    delivered = []
    original_receive = WebSocket.receive

    async def observe_receive(self):
        event = await original_receive(self)
        if event["type"] == "websocket.receive":
            delivered.append(event)
        return event

    monkeypatch.setattr(WebSocket, "receive", observe_receive)
    with websocket_connect(
        f"{live_server}/ws/meetings/{code}",
        origin="http://localhost:3000",
        proxy=None,
    ) as ws:
        # Compression is disabled, so large compressed frames cannot amplify memory.
        assert "Sec-WebSocket-Extensions" not in ws.response.headers
        if authenticated:
            ws.send(
                json.dumps({"type": "auth", "token": admission["participant_token"]})
            )
            assert json.loads(ws.recv(timeout=3))["type"] == "welcome"
        delivered.clear()
        if encoding == "binary":
            payload = b"x" * (MAX_MESSAGE_BYTES + 1)
        elif encoding == "fragmented":
            # Individually legal fragments, but their aggregate UTF-8 bytes exceed 64 KiB.
            payload = ["é" * 16_384, "é" * 16_385]
        else:
            payload = "x" * (MAX_MESSAGE_BYTES + 1)
        ws.send(payload)
        with pytest.raises(ConnectionClosed) as error:
            ws.recv(timeout=3)
        assert error.value.rcvd.code == 1009
        assert delivered == []


def test_real_transport_accepts_near_limit_offer_and_authentication(
    client, live_server
):
    created = create(client)
    code = created["meeting"]["meeting_code"]
    host, guest = admit(client, created, "Host", True), admit(client, created, "Guest")
    with (
        websocket_connect(
            f"{live_server}/ws/meetings/{code}",
            origin="http://localhost:3000",
            proxy=None,
        ) as first,
        websocket_connect(
            f"{live_server}/ws/meetings/{code}",
            origin="http://localhost:3000",
            proxy=None,
        ) as second,
    ):
        for ws, admission in [(first, host), (second, guest)]:
            ws.send(
                json.dumps({"type": "auth", "token": admission["participant_token"]})
            )
            assert json.loads(ws.recv(timeout=3))["type"] == "welcome"
        assert json.loads(first.recv(timeout=3))["type"] == "participant-joined"
        offer = {
            "type": "offer",
            "target": guest["participant"]["id"],
            "payload": {"type": "offer", "sdp": "v=0\r\n" + "a" * 60_000},
        }
        raw = json.dumps(offer)
        assert len(raw.encode()) < MAX_MESSAGE_BYTES
        first.send(raw)
        received = json.loads(second.recv(timeout=3))
        assert received["payload"] == offer["payload"]
        assert received["sender"] == host["participant"]["id"]
