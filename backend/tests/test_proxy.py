import asyncio

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import app
from app.proxy import TrustedProxyMiddleware
from app.server import server_config
from app.websocket.manager import manager
from test_meetings import create
from test_signaling import ORIGIN, admit, connect


@pytest.mark.parametrize("kind", ["http", "websocket"])
@pytest.mark.parametrize(
    "peer,headers,expected",
    [
        ("100.64.0.4", [(b"x-real-ip", b"198.51.100.7")], "198.51.100.7"),
        ("100.64.0.8", [(b"x-real-ip", b"2001:db8::7")], "2001:db8::7"),
        ("198.51.100.8", [(b"x-real-ip", b"198.51.100.7")], "198.51.100.8"),
        ("100.64.0.4", [(b"x-forwarded-for", b"198.51.100.7")], "100.64.0.4"),
        ("100.64.0.4", [(b"x-real-ip", b"invalid")], "100.64.0.4"),
        ("100.64.0.4", [(b"x-real-ip", b"198.51.100.7, 1.1.1.1")], "100.64.0.4"),
        (
            "100.64.0.4",
            [(b"x-real-ip", b"1.1.1.1"), (b"x-real-ip", b"8.8.8.8")],
            "100.64.0.4",
        ),
    ],
)
def test_proxy_identity_is_explicit_and_consistent(kind, peer, headers, expected):
    captured = []

    async def destination(scope, receive, send):
        captured.append(scope)

    scope = {
        "type": kind,
        "client": (peer, 123),
        "scheme": "ws" if kind == "websocket" else "http",
        "headers": headers + [(b"x-forwarded-proto", b"https")],
    }
    asyncio.run(TrustedProxyMiddleware(destination, "100.64.0.0/24")(scope, None, None))
    assert captured[0]["client"][0] == expected
    if expected != peer:
        assert captured[0]["scheme"] == ("wss" if kind == "websocket" else "https")
    else:
        assert captured[0]["scheme"] == scope["scheme"]
    assert scope["client"][0] == peer  # A shared scope is never mutated in place.


def test_empty_trust_policy_and_uvicorn_ignore_forwarded_headers():
    assert server_config("127.0.0.1", 8000).proxy_headers is False
    captured = []

    async def destination(scope, receive, send):
        captured.append(scope)

    scope = {"type": "http", "client": ("127.0.0.1", 1)}
    asyncio.run(TrustedProxyMiddleware(destination)(scope, None, None))
    assert captured == [scope]


@pytest.mark.parametrize("value", ["*", "0.0.0.0/0", "::/0", "invalid"])
def test_proxy_configuration_rejects_unbounded_trust(value):
    with pytest.raises(ValueError, match="TRUSTED_PROXY_CIDRS"):
        Settings(_env_file=None, trusted_proxy_cidrs=value)


def test_proxy_rate_budgets_and_websocket_gate_use_resolved_identity(client):
    proxy = TestClient(
        TrustedProxyMiddleware(app, "100.64.0.0/24"), client=("100.64.0.4", 123)
    )
    try:
        first = {"X-Real-IP": "198.51.100.7", "X-Forwarded-For": "forged"}
        assert proxy.get("/api/user", headers=first).status_code == 200
        app.state.rest_limiter.clients[("198.51.100.7", "read")].tokens = -100
        assert proxy.get("/api/user", headers=first).status_code == 429
        assert (
            proxy.get(
                "/api/user", headers={**first, "X-Forwarded-For": "other"}
            ).status_code
            == 429
        )
        assert (
            proxy.get("/api/user", headers={"X-Real-IP": "198.51.100.8"}).status_code
            == 200
        )

        created = create(client)
        admission = admit(client, created, "Host", True)
        with proxy.websocket_connect(
            f"/ws/meetings/{created['meeting']['meeting_code']}",
            headers={**ORIGIN, **first},
        ) as ws:
            assert connect(ws, admission)["type"] == "welcome"
            ws.send_json({"type": "ping"})
            assert ws.receive_json() == {"type": "pong"}
        assert "198.51.100.7" in manager.gate.attempts_by_ip
        assert "100.64.0.4" not in manager.gate.attempts_by_ip
    finally:
        proxy.close()
