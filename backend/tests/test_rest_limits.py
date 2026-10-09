import time

import pytest

from app.api.rate_limit import RestRateLimiter, request_group
from app.main import app


def test_bursts_refill_and_client_isolation():
    limiter = RestRateLimiter()
    now = time.monotonic()
    for _ in range(30):
        assert limiter.check("one", "create", now) == 0
    assert limiter.check("one", "create", now) == 2
    assert limiter.check("two", "create", now) == 0
    assert limiter.check("one", "join", now) == 0
    assert limiter.check("one", "create", now + 2) == 0


def test_bounded_memory_and_global_limit():
    limiter = RestRateLimiter(max_keys=3)
    now = time.monotonic()
    for index in range(300):
        assert limiter.check(str(index), "create", now) == 0
        assert len(limiter.clients) <= 3
    assert limiter.check("new-ip", "create", now) == 1


@pytest.mark.parametrize(
    "action,group",
    [
        ("instant", "create"),
        ("schedule", "create"),
        ("12345678901/join", "join"),
        ("12345678901/claim", "claim"),
        ("12345678901/start", "host"),
        ("12345678901/end", "host"),
    ],
)
def test_mutation_groups(action, group):
    assert request_group("POST", f"/api/meetings/{action}") == group


def test_health_preflight_and_leave_are_exempt():
    assert request_group("GET", "/api/health") is None
    assert request_group("OPTIONS", "/api/meetings/instant") is None
    assert request_group("POST", "/api/meetings/12345678901/leave") is None
    assert request_group("GET", "/api/meetings/upcoming") == "read"


@pytest.mark.parametrize(
    "path,group",
    [
        ("instant", "create"),
        ("schedule", "create"),
        ("12345678901/join", "join"),
        ("12345678901/claim", "claim"),
    ],
)
def test_rejected_before_database_or_body_parsing(client, monkeypatch, path, group):
    limiter = app.state.rest_limiter
    bucket = limiter.global_buckets[group]
    bucket.tokens = -100

    # A 429 must precede validation/DB work, including malformed request bodies.
    def unexpected_db():
        raise AssertionError("Rate-limited request opened a database session")

    monkeypatch.setattr("app.database.SessionLocal", unexpected_db)
    response = client.post(
        f"/api/meetings/{path}",
        content=b"{invalid",
        headers={"Origin": "http://localhost:3000", "X-Forwarded-For": "forged-ip"},
    )
    assert response.status_code == 429
    assert response.json()["error"]["code"] == "RATE_LIMITED"
    assert int(response.headers["Retry-After"]) >= 1
    assert response.headers["Access-Control-Allow-Origin"] == "http://localhost:3000"
    assert all(key[0] == "testclient" for key in limiter.clients)


def test_cleanup_and_authorization_work_after_creation_limit(client):
    created = client.post("/api/meetings/instant").json()
    code = created["meeting"]["meeting_code"]
    app.state.rest_limiter.global_buckets["create"].tokens = -100
    assert client.post("/api/meetings/instant").status_code == 429
    assert client.post(f"/api/meetings/{code}/end").status_code == 403
    assert (
        client.post(
            f"/api/meetings/{code}/end",
            headers={"Authorization": f"Bearer {created['host_token']}"},
        ).status_code
        == 200
    )
    assert client.get("/api/health").status_code == 200
