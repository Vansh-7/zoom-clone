from datetime import datetime, timedelta

import pytest
from sqlalchemy import func, select

from app.database import SessionLocal
from app.models import Meeting


@pytest.mark.parametrize(
    "scheduled,expected",
    [
        ("2030-01-02T09:00:00+05:30", "20300102T033000Z"),
        ("2030-07-02T09:00:00-04:00", "20300702T130000Z"),
        ("2030-01-02T09:00:00-05:00", "20300102T140000Z"),
    ],
)
def test_calendar_utc_duration_and_persistence(client, scheduled, expected):
    body = {
        "title": "Team sync",
        "description": "Discuss progress",
        "scheduled_at": scheduled,
        "duration_minutes": 45,
    }
    meeting = client.post("/api/meetings/schedule", json=body).json()["meeting"]
    code = meeting["meeting_code"]
    response = client.get(f"/api/meetings/{code}/calendar")
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/calendar; charset=utf-8"
    assert (
        response.headers["content-disposition"]
        == f'attachment; filename="meeting-{code}.ics"'
    )
    assert b"\r\n" in response.content
    assert b"\n" not in response.content.replace(b"\r\n", b"")
    unfolded = response.text.replace("\r\n ", "")
    assert f"DTSTART:{expected}\r\n" in unfolded
    end = datetime.strptime(expected, "%Y%m%dT%H%M%SZ") + timedelta(minutes=45)
    assert f"DTEND:{end:%Y%m%dT%H%M%SZ}\r\n" in unfolded
    for value in [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "SUMMARY:Team sync",
        f"UID:{code}@localhost",
        f"URL:{meeting['invite_url']}",
        "END:VEVENT",
        "END:VCALENDAR",
    ]:
        assert value + "\r\n" in unfolded
    assert "DESCRIPTION:Discuss progress\\n\\nJoin:" in unfolded
    assert response.content == client.get(f"/api/meetings/{code}/calendar").content
    assert client.get(f"/api/meetings/{code}").json() == meeting
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Meeting)) == 7


def test_calendar_text_injection_unicode_and_octet_folding(client):
    title = "Review, roadmap; \\ café 世界 " * 9
    description = "First line\r\nBEGIN:VEVENT\nSecond; line, \\done " + "世界" * 40
    meeting = client.post(
        "/api/meetings/schedule",
        json={
            "title": title[:200],
            "description": description,
            "scheduled_at": "2030-01-02T09:00:00Z",
            "duration_minutes": 30,
        },
    ).json()["meeting"]
    content = client.get(f"/api/meetings/{meeting['meeting_code']}/calendar").content
    assert all(len(line) <= 75 for line in content.split(b"\r\n"))
    for line in content.split(b"\r\n"):
        line.decode("utf-8")
    unfolded = content.decode().replace("\r\n ", "")
    assert unfolded.split("\r\n").count("BEGIN:VEVENT") == 1
    assert "Review\\, roadmap\\; \\\\ café 世界" in unfolded
    assert "First line\\nBEGIN:VEVENT\\nSecond\\; line\\, \\\\done" in unfolded


def test_calendar_rejects_instant_and_missing_meetings(client):
    code = client.post("/api/meetings/instant").json()["meeting"]["meeting_code"]
    assert client.get(f"/api/meetings/{code}/calendar").status_code == 409
    assert client.get("/api/meetings/11111111111/calendar").status_code == 404
