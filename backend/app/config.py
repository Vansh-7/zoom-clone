import json
from ipaddress import ip_network
from functools import lru_cache
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class IceServer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)

    urls: str | list[str]
    username: str | None = None
    credential: str | None = None
    credentialType: Literal["password"] | None = None

    @model_validator(mode="after")
    def valid_server(self):
        urls = [self.urls] if isinstance(self.urls, str) else self.urls
        if not urls:
            raise ValueError("ICE server URLs cannot be empty")
        for url in urls:
            scheme, separator, address = url.partition(":")
            authority, _, query = address.partition("?")
            if (
                not separator
                or scheme not in {"stun", "stuns", "turn", "turns"}
                or any(char.isspace() for char in url)
                or "/" in address
                or "#" in address
                or (
                    query
                    and (
                        scheme not in {"turn", "turns"}
                        or query not in {"transport=udp", "transport=tcp"}
                    )
                )
            ):
                raise ValueError("Use stun:, stuns:, turn:, or turns: ICE URLs")
            parsed = urlsplit("//" + authority)
            if (
                not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.port == 0
            ):
                raise ValueError("ICE URLs require a hostname and a valid port")
            if scheme in {"turn", "turns"} and (
                not self.username or not self.credential
            ):
                raise ValueError("TURN servers require username and credential")
        return self


def parse_ice_servers(raw: str) -> list[dict]:
    try:
        values = json.loads(raw)
        if not isinstance(values, list):
            raise ValueError()
        return [
            IceServer.model_validate(value).model_dump(exclude_none=True)
            for value in values
        ]
    except (ValueError, TypeError):
        raise ValueError(
            "ICE_SERVERS_JSON must be a JSON array of valid ICE servers; TURN requires username and credential"
        ) from None


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", extra="ignore", hide_input_in_errors=True
    )

    database_url: str = "sqlite:///./data/zoom.db"
    frontend_url: str = "http://localhost:3000"
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    seed_data: bool = True
    max_participants: int = 4
    disconnect_grace_seconds: float = 30
    ice_servers_json: str = '[{"urls":"stun:stun.l.google.com:19302"}]'
    ice_transport_policy: Literal["all", "relay"] = "all"
    trusted_proxy_cidrs: str = ""

    @field_validator("trusted_proxy_cidrs")
    @classmethod
    def valid_proxy_networks(cls, value: str) -> str:
        try:
            networks = [
                ip_network(item.strip()) for item in value.split(",") if item.strip()
            ]
            if any(network.prefixlen == 0 for network in networks):
                raise ValueError()
            return ",".join(str(network) for network in networks)
        except ValueError:
            raise ValueError(
                "TRUSTED_PROXY_CIDRS requires explicit proxy IPs/CIDRs, not * or all addresses"
            ) from None

    @field_validator("ice_servers_json")
    @classmethod
    def valid_ice_servers(cls, value: str) -> str:
        parse_ice_servers(value)
        return value

    @model_validator(mode="after")
    def relay_requires_turn(self):
        if self.ice_transport_policy == "relay" and not any(
            url.startswith(("turn:", "turns:"))
            for server in self.ice_servers
            for url in (
                [server["urls"]] if isinstance(server["urls"], str) else server["urls"]
            )
        ):
            raise ValueError("ICE_TRANSPORT_POLICY=relay requires a TURN server")
        return self

    @field_validator("max_participants")
    @classmethod
    def valid_capacity(cls, value: int) -> int:
        if not 2 <= value <= 6:
            raise ValueError("MAX_PARTICIPANTS must be between 2 and 6")
        return value

    @property
    def allowed_origins(self) -> list[str]:
        return [
            origin.strip().rstrip("/")
            for origin in self.cors_origins.split(",")
            if origin.strip()
        ]

    @property
    def ice_servers(self) -> list[dict]:
        return parse_ice_servers(self.ice_servers_json)


@lru_cache
def get_settings() -> Settings:
    return Settings()
