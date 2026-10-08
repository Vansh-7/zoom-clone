from datetime import datetime, timedelta
from unittest.mock import patch

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError

from app.database import SessionLocal, utcnow
from app.models import Meeting, User
from app.services.meetings import replenish_samples, seed_database


def create(client):
    result = client.post("/api/meetings/instant")
    assert result.status_code == 201
    return result.json()


def host_header(created):
    return {"Authorization": "Bearer " + created["host_token"]}


def schedule_body(**changes):
    return {
        "title": "Tomorrow's review",
        "description": "Bring your ideas",
        "scheduled_at": (utcnow() + timedelta(days=1)).isoformat(),
        "scheduled_timezone": "Asia/Kolkata",
        "duration_minutes": 45,
        **changes,
    }


def test_health_and_idempotent_seed(client):
    assert client.get("/api/health").json() == {"status": "ok", "database": "sqlite"}
    with SessionLocal() as db:
        seed_database(db)
        seed_database(db)
        assert db.scalar(select(func.count()).select_from(Meeting)) == 6
        assert db.scalar(select(func.count()).select_from(User)) == 1
        assert db.execute(text("PRAGMA foreign_keys")).scalar() == 1
    assert len(client.get("/api/meetings/upcoming").json()) == 3
    assert len(client.get("/api/meetings/recent").json()) == 3
    assert client.get("/api/user").json()["name"] == "Alex Morgan"


def test_instant_persists_unique_ids_and_redacts_tokens(client):
    one, two = create(client), create(client)
    code = one["meeting"]["meeting_code"]
    assert len(code) == 11 and code.isdigit()
    assert code != two["meeting"]["meeting_code"]
    assert one["meeting"]["invite_url"] == f"http://localhost:3000/meeting/{code}"
    result = client.get(f"/api/meetings/{code}")
    assert result.status_code == 200
    assert "token" not in result.text
    with SessionLocal() as db:
        meeting = db.scalar(select(Meeting).where(Meeting.meeting_code == code))
        assert meeting.host_token_hash != one["host_token"]
        assert meeting.host.name == "Alex Morgan"
        assert meeting.started_at.tzinfo is not None


def test_id_collision_retry_and_exhaustion(client):
    code = create(client)["meeting"]["meeting_code"]
    with patch(
        "app.services.meetings.generate_code", side_effect=[code, "99999999999"]
    ):
        assert create(client)["meeting"]["meeting_code"] == "99999999999"
    with patch("app.services.meetings.generate_code", return_value=code):
        assert client.post("/api/meetings/instant").status_code == 503


@pytest.mark.parametrize(
    "code", ["123", "not-a-code", "11111111111", "１２３４５６７８９０１"]
)
def test_invalid_meeting(client, code):
    response = client.get(f"/api/meetings/{code}")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "MEETING_NOT_FOUND"


def test_schedule_persistence_and_timezone(client):
    body = schedule_body(
        scheduled_at=(utcnow() + timedelta(days=2))
        .astimezone(__import__("datetime").timezone(timedelta(hours=5, minutes=30)))
        .isoformat()
    )
    result = client.post("/api/meetings/schedule", json=body)
    assert result.status_code == 201
    meeting = result.json()["meeting"]
    assert meeting["status"] == "scheduled"
    assert meeting["scheduled_at"].endswith("Z") or meeting["scheduled_at"].endswith(
        "+00:00"
    )
    assert meeting["meeting_code"] in [
        m["meeting_code"] for m in client.get("/api/meetings/upcoming").json()
    ]
    with SessionLocal() as db:
        stored = db.scalar(
            select(Meeting).where(Meeting.meeting_code == meeting["meeting_code"])
        )
        assert (
            stored.description == body["description"] and stored.duration_minutes == 45
        )


@pytest.mark.parametrize(
    "changes",
    [
        {"title": " "},
        {"duration_minutes": 0},
        {"duration_minutes": 481},
        {"duration_minutes": "30"},
        {"scheduled_at": "2020-01-01T12:00:00Z"},
        {"scheduled_at": "2026-10-09T12:00:00"},
        {"scheduled_timezone": "Mars/City"},
        {"description": "x" * 2001},
    ],
)
def test_invalid_schedule(client, changes):
    result = client.post("/api/meetings/schedule", json=schedule_body(**changes))
    assert result.status_code == 422
    assert "error" in result.json()


def test_wait_start_claim_and_end(client):
    meeting = client.get("/api/meetings/upcoming").json()[0]
    code = meeting["meeting_code"]
    assert (
        client.post(
            f"/api/meetings/{code}/join", json={"display_name": "Guest"}
        ).json()["error"]["code"]
        == "HOST_NOT_STARTED"
    )
    assert client.post(f"/api/meetings/{code}/start").status_code == 403
    claimed = client.post(f"/api/meetings/{code}/claim").json()
    assert client.post(f"/api/meetings/{code}/claim").status_code == 409
    assert (
        client.post(
            f"/api/meetings/{code}/start", headers=host_header(claimed)
        ).status_code
        == 200
    )
    assert client.post(f"/api/meetings/{code}/end").status_code == 403
    assert (
        client.post(
            f"/api/meetings/{code}/end", headers=host_header(claimed)
        ).status_code
        == 200
    )
    assert (
        client.post(
            f"/api/meetings/{code}/join", json={"display_name": "Guest"}
        ).json()["error"]["code"]
        == "MEETING_ENDED"
    )
    assert code in [
        m["meeting_code"] for m in client.get("/api/meetings/recent").json()
    ]


def test_real_meetings_cannot_be_claimed(client):
    code = create(client)["meeting"]["meeting_code"]
    assert client.post(f"/api/meetings/{code}/claim").status_code == 403


def test_join_validation_roles_capacity_and_leave(client):
    meeting = create(client)
    code = meeting["meeting"]["meeting_code"]
    assert (
        client.post(
            f"/api/meetings/{code}/join", json={"display_name": " "}
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"/api/meetings/{code}/join", json={"display_name": "Guest", "role": "host"}
        ).status_code
        == 422
    )
    host = client.post(
        f"/api/meetings/{code}/join",
        json={"display_name": "Alex"},
        headers=host_header(meeting),
    ).json()
    assert host["participant"]["role"] == "host"
    assert (
        client.post(
            f"/api/meetings/{code}/join",
            json={"display_name": "Alex"},
            headers=host_header(meeting),
        ).status_code
        == 409
    )
    guest = client.post(
        f"/api/meetings/{code}/join", json={"display_name": "Sam"}
    ).json()
    assert guest["participant"]["role"] == "guest"
    assert (
        client.post(
            f"/api/meetings/{code}/join", json={"display_name": "Third"}
        ).json()["error"]["code"]
        == "MEETING_FULL"
    )
    header = {"Authorization": "Bearer " + guest["participant_token"]}
    assert client.post(f"/api/meetings/{code}/leave", headers=header).status_code == 200
    assert client.post(f"/api/meetings/{code}/leave", headers=header).status_code == 401
    assert (
        client.post(
            f"/api/meetings/{code}/join", json={"display_name": "Third"}
        ).status_code
        == 201
    )


def test_expired_schedule_and_foreign_keys(client):
    with SessionLocal() as db:
        meeting = db.scalar(select(Meeting).where(Meeting.status == "scheduled"))
        meeting.scheduled_at = utcnow() - timedelta(days=1)
        code = meeting.meeting_code
        db.commit()
        db.add(
            Meeting(
                meeting_code="99999999999",
                host_id=9999,
                title="Invalid host",
                kind="instant",
                status="in_progress",
            )
        )
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()
    assert code not in [
        m["meeting_code"] for m in client.get("/api/meetings/upcoming").json()
    ]
    assert (
        next(
            m
            for m in client.get("/api/meetings/recent").json()
            if m["meeting_code"] == code
        )["status"]
        == "missed"
    )


def test_cors(client):
    allowed = client.options(
        "/api/meetings",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert (
        "access-control-allow-origin"
        not in client.get(
            "/api/meetings", headers={"Origin": "https://evil.example"}
        ).headers
    )


def test_samples_replenish_days_later_without_rewriting_history(client):
    real = client.post("/api/meetings/schedule", json=schedule_body()).json()["meeting"]
    now = utcnow()
    with SessionLocal() as db:
        original = {
            m.meeting_code: (m.scheduled_at, m.title, m.host_token_hash)
            for m in db.scalars(select(Meeting))
        }
    with patch("app.services.meetings.utcnow", return_value=now + timedelta(days=7)):
        upcoming = client.get("/api/meetings/upcoming").json()
        assert len(upcoming) == 3
        assert all(m["can_claim"] for m in upcoming)
        assert all(
            datetime.fromisoformat(m["scheduled_at"].replace("Z", "+00:00"))
            > now + timedelta(days=7)
            for m in upcoming
        )
        codes = {m["meeting_code"] for m in upcoming}
        with SessionLocal() as db:
            seed_database(db)
            replenish_samples(db)
            assert db.scalar(select(func.count()).select_from(Meeting)) == 10
            for code, values in original.items():
                m = db.scalar(select(Meeting).where(Meeting.meeting_code == code))
                assert (m.scheduled_at, m.title, m.host_token_hash) == values
        assert codes == {
            m["meeting_code"] for m in client.get("/api/meetings/upcoming").json()
        }
        assert real["meeting_code"] in {
            m["meeting_code"] for m in client.get("/api/meetings/recent").json()
        }


def test_claimed_demo_is_preserved_and_daily_replenishment_is_bounded(client):
    sample = client.get("/api/meetings/upcoming").json()[0]
    code = sample["meeting_code"]
    claim = client.post(f"/api/meetings/{code}/claim").json()
    for _ in range(3):
        client.get("/api/meetings/upcoming")
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Meeting)) == 7
        claimed = db.scalar(select(Meeting).where(Meeting.meeting_code == code))
        assert (
            claimed.host_token_hash
            and claimed.scheduled_at.isoformat().replace("+00:00", "Z")
            == sample["scheduled_at"]
        )
    assert (
        client.post(
            f"/api/meetings/{code}/start", headers=host_header(claim)
        ).status_code
        == 200
    )
    # Claiming the replacement cannot create unlimited new samples on the same day.
    replacement = next(
        m
        for m in client.get("/api/meetings/upcoming").json()
        if m["title"] == sample["title"] and m["can_claim"]
    )
    client.post(f"/api/meetings/{replacement['meeting_code']}/claim")
    client.get("/api/meetings/upcoming")
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Meeting)) == 7


def test_replenishment_retries_code_collision_and_respects_seed_setting(client):
    now = utcnow() + timedelta(days=7)
    with (
        patch("app.services.meetings.utcnow", return_value=now),
        patch(
            "app.services.meetings.generate_code",
            side_effect=["81234567000", "99999999991", "99999999992", "99999999993"],
        ),
    ):
        with SessionLocal() as db:
            seed_database(db, samples=False)
            assert db.scalar(select(func.count()).select_from(Meeting)) == 6
            replenish_samples(db)
            assert db.scalar(select(func.count()).select_from(Meeting)) == 9
