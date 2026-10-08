import os
import tempfile

os.environ["DATABASE_URL"] = (
    "sqlite:///"
    + tempfile.mkdtemp(prefix="zoom-tests-").replace("\\", "/")
    + "/tests.db"
)
os.environ["DISCONNECT_GRACE_SECONDS"] = "0.05"

import pytest
from fastapi.testclient import TestClient

from app.database import Base, engine
from app.main import app
from app.websocket.limits import ConnectionGate
from app.websocket.manager import manager


@pytest.fixture
def client(monkeypatch):
    Base.metadata.drop_all(engine)
    monkeypatch.setattr(manager, "gate", ConnectionGate())
    with TestClient(app) as test_client:
        yield test_client
