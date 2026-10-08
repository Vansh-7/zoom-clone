import time
from collections import OrderedDict
from dataclasses import dataclass, field

MAX_MESSAGE_BYTES = 65_536
AUTH_TIMEOUT_SECONDS = 5
MAX_INVALID_MESSAGES = 8


@dataclass
class TokenBucket:
    capacity: float
    refill_per_second: float
    tokens: float = field(init=False)
    updated_at: float = field(default_factory=time.monotonic)

    def __post_init__(self):
        self.tokens = self.capacity

    def take(self, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        self.tokens = min(
            self.capacity,
            self.tokens + max(0, now - self.updated_at) * self.refill_per_second,
        )
        self.updated_at = now
        if self.tokens < 1:
            return False
        self.tokens -= 1
        return True


class ConnectionGate:
    """Synchronous counters are atomic between awaits in our single event loop."""

    def __init__(self, total_limit=128, pending_limit=32, per_ip_pending_limit=8):
        self.total_limit = total_limit
        self.pending_limit = pending_limit
        self.per_ip_pending_limit = per_ip_pending_limit
        self.total = 0
        self.pending = 0
        self.pending_by_ip: dict[str, int] = {}
        self.attempts = TokenBucket(60, 10)
        self.attempts_by_ip: OrderedDict[str, TokenBucket] = OrderedDict()

    def acquire(self, ip: str) -> bool:
        if (
            self.total >= self.total_limit
            or self.pending >= self.pending_limit
            or self.pending_by_ip.get(ip, 0) >= self.per_ip_pending_limit
        ):
            return False
        bucket = self.attempts_by_ip.get(ip)
        if bucket is None:
            # Bound memory even when many distinct network peers try to connect.
            if len(self.attempts_by_ip) >= 1024:
                self.attempts_by_ip.popitem(last=False)
            bucket = self.attempts_by_ip[ip] = TokenBucket(40, 2)
        self.attempts_by_ip.move_to_end(ip)
        if not bucket.take() or not self.attempts.take():
            return False
        self.total += 1
        self.pending += 1
        self.pending_by_ip[ip] = self.pending_by_ip.get(ip, 0) + 1
        return True

    def authenticated(self, ip: str):
        self.pending -= 1
        remaining = self.pending_by_ip[ip] - 1
        if remaining:
            self.pending_by_ip[ip] = remaining
        else:
            self.pending_by_ip.pop(ip)

    def release(self, ip: str, pending: bool):
        self.total -= 1
        if pending:
            self.authenticated(ip)
