"""Bound public REST traffic before parsing bodies or opening database sessions."""

import math
import time
from collections import OrderedDict

from starlette.responses import JSONResponse

from app.websocket.limits import TokenBucket


class RestRateLimiter:
    # Burst capacity and sustained requests/second; shared NATs can still join calls.
    policies = {
        "create": (30, 0.5),
        "join": (60, 1),
        "claim": (20, 0.25),
        "read": (120, 3),
        "host": (60, 1),
    }

    def __init__(self, max_keys=4096):
        self.max_keys = max_keys
        self.clients: OrderedDict[tuple[str, str], TokenBucket] = OrderedDict()
        self.global_buckets = {
            key: TokenBucket(capacity * 10, refill * 10)
            for key, (capacity, refill) in self.policies.items()
        }

    def check(self, ip: str, group: str, now: float | None = None) -> int:
        now = time.monotonic() if now is None else now
        key = (ip, group)
        bucket = self.clients.get(key)
        if bucket is None:
            if len(self.clients) >= self.max_keys:
                self.clients.popitem(last=False)
            bucket = self.clients[key] = TokenBucket(*self.policies[group])
        self.clients.move_to_end(key)
        for item in (bucket, self.global_buckets[group]):
            # Refill without charging either bucket until both can admit the request.
            item.tokens = min(
                item.capacity,
                item.tokens + max(0, now - item.updated_at) * item.refill_per_second,
            )
            item.updated_at = now
        wait = max(
            (1 - item.tokens) / item.refill_per_second
            for item in (bucket, self.global_buckets[group])
        )
        if wait > 0:
            return max(1, math.ceil(wait))
        bucket.tokens -= 1
        self.global_buckets[group].tokens -= 1
        return 0


def request_group(method: str, path: str) -> str | None:
    path = path.rstrip("/")
    if method == "GET" and path.startswith("/api/") and path != "/api/health":
        return "read"
    if method != "POST" or not path.startswith("/api/meetings/"):
        return None
    action = path.rsplit("/", 1)[-1]
    if action in {"instant", "schedule"}:
        return "create"
    if action in {"join", "claim", "start", "end"}:
        return {"start": "host", "end": "host"}.get(action, action)
    return None


class RestRateLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            group = request_group(scope["method"], scope["path"])
            if group:
                # Trust only ASGI's client, never caller-supplied forwarding headers.
                ip = (scope.get("client") or ("unknown", 0))[0]
                retry = scope["app"].state.rest_limiter.check(ip, group)
                if retry:
                    response = JSONResponse(
                        {
                            "error": {
                                "code": "RATE_LIMITED",
                                "message": "Too many requests. Please wait a moment and try again.",
                            }
                        },
                        status_code=429,
                        headers={
                            "Retry-After": str(retry),
                            "Cache-Control": "no-store",
                        },
                    )
                    await response(scope, receive, send)
                    return
        await self.app(scope, receive, send)
