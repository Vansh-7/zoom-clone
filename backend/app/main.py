import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select, update
from sqlalchemy.exc import SQLAlchemyError
from starlette.concurrency import run_in_threadpool

from app.api.routes import router, ws_router
from app.config import get_settings
from app.database import Base, SessionLocal, engine, utcnow
from app.models import Meeting, MeetingParticipant
from app.services.meetings import AppError, reconcile_schedules, seed_database
from app.websocket.manager import manager

logger = logging.getLogger(__name__)


def initialize():
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        # A restarted process cannot recover in-memory peer signaling sessions.
        db.execute(
            update(MeetingParticipant)
            .where(MeetingParticipant.left_at.is_(None))
            .values(left_at=utcnow())
        )
        db.execute(
            update(Meeting)
            .where(Meeting.status == "in_progress")
            .values(status="ended", ended_at=utcnow())
        )
        db.commit()
        seed_database(db, get_settings().seed_data)


async def maintenance():
    while True:
        await asyncio.sleep(15)
        active_ids = {pid for room in manager.rooms.values() for pid in room}

        def cleanup():
            from datetime import timedelta

            with SessionLocal() as db:
                reconcile_schedules(db)
                stale = db.scalars(
                    select(MeetingParticipant).where(
                        MeetingParticipant.left_at.is_(None),
                        MeetingParticipant.joined_at < utcnow() - timedelta(seconds=60),
                    )
                )
                for participant in stale:
                    if participant.id not in active_ids:
                        participant.left_at = utcnow()
                db.commit()

        await run_in_threadpool(cleanup)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await run_in_threadpool(initialize)
    task = asyncio.create_task(maintenance())
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task
    await manager.shutdown()


app = FastAPI(
    title="Zoom Clone API",
    version="1.0.0",
    lifespan=lifespan,
    description="SQLite-backed meetings and small-room WebRTC signaling. No account login is required.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().allowed_origins,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


@app.exception_handler(AppError)
async def app_error(request: Request, exc: AppError):
    return JSONResponse(
        status_code=exc.status,
        content={"error": {"code": exc.code, "message": exc.message}},
    )


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    fields = {
        ".".join(str(part) for part in error["loc"][1:]): error["msg"]
        for error in exc.errors()
    }
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": "VALIDATION_ERROR",
                "message": "Check the highlighted fields and try again.",
                "fields": fields,
            }
        },
    )


app.include_router(router)
app.include_router(ws_router)


@app.exception_handler(SQLAlchemyError)
async def database_error(request: Request, exc: SQLAlchemyError):
    logger.error("Database operation failed: %s", type(exc).__name__)
    return JSONResponse(
        status_code=503,
        content={
            "error": {
                "code": "DATABASE_UNAVAILABLE",
                "message": "The meeting database is temporarily unavailable. Please try again.",
            }
        },
    )


@app.exception_handler(Exception)
async def unexpected_error(request: Request, exc: Exception):
    logger.error("Unexpected request failure: %s", type(exc).__name__)
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "code": "INTERNAL_ERROR",
                "message": "Something went wrong on the server. Please try again.",
            }
        },
    )
