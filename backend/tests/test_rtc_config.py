import json

import pytest
from pydantic import ValidationError

from app.config import Settings, get_settings


def test_default_capacity_is_four_and_advertised(client, monkeypatch):
    monkeypatch.delenv("MAX_PARTICIPANTS", raising=False)
    capacity = Settings(_env_file=None).max_participants
    assert capacity == 4
    monkeypatch.setattr(get_settings(), "max_participants", capacity)
    assert client.get("/api/rtc-config").json()["max_participants"] == 4


def test_stun_and_authenticated_turn_roundtrip(client, monkeypatch):
    servers = [
        {"urls": "stun:stun.example.com:3478"},
        {
            "urls": [
                "turn:relay.example.com:3478?transport=udp",
                "turns:relay.example.com:443?transport=tcp",
            ],
            "username": "test-user",
            "credential": "test-password",
            "credentialType": "password",
        },
    ]
    monkeypatch.setattr(get_settings(), "ice_servers_json", json.dumps(servers))
    monkeypatch.setattr(get_settings(), "ice_transport_policy", "relay")
    response = client.get("/api/rtc-config")
    assert response.status_code == 200
    assert response.json()["ice_servers"] == servers
    assert response.json()["ice_transport_policy"] == "relay"
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    "value",
    [
        "not-json",
        "{}",
        '[{"url":"stun:stun.example.com"}]',
        '[{"urls":[]}]',
        '[{"urls":"https://relay.example.com"}]',
        '[{"urls":"turn:relay.example.com:3478"}]',
        '[{"urls":"stun:relay.example.com:99999"}]',
        '[{"urls":"stun://relay.example.com"}]',
        '[{"urls":"stun:relay.example.com bad"}]',
    ],
)
def test_invalid_ice_config_fails_early_without_exposing_value(value):
    with pytest.raises(ValidationError) as error:
        Settings(_env_file=None, ice_servers_json=value)
    assert value not in str(error.value)


def test_relay_policy_requires_turn():
    with pytest.raises(ValidationError, match="requires a TURN server"):
        Settings(_env_file=None, ice_transport_policy="relay", ice_servers_json="[]")


def test_host_only_ice_config_is_allowed():
    assert Settings(_env_file=None, ice_servers_json="[]").ice_servers == []
