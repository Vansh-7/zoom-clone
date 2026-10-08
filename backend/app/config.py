import json
from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./data/zoom.db"
    frontend_url: str = "http://localhost:3000"
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    seed_data: bool = True
    max_participants: int = 2
    disconnect_grace_seconds: float = 30
    ice_servers_json: str = '[{"urls":"stun:stun.l.google.com:19302"}]'

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
        result = json.loads(self.ice_servers_json)
        if not isinstance(result, list):
            raise ValueError("ICE_SERVERS_JSON must be a JSON array")
        return result


@lru_cache
def get_settings() -> Settings:
    return Settings()
