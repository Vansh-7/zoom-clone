"""Resolve Railway edge identity only from explicitly trusted network peers."""

from ipaddress import ip_address, ip_network


class TrustedProxyMiddleware:
    def __init__(self, app, trusted_proxy_cidrs: str = ""):
        self.app = app
        self.networks = [
            ip_network(item.strip())
            for item in trusted_proxy_cidrs.split(",")
            if item.strip()
        ]

    async def __call__(self, scope, receive, send):
        if scope["type"] in {"http", "websocket"} and self.networks:
            try:
                peer = ip_address((scope.get("client") or ("", 0))[0])
                trusted = any(peer in network for network in self.networks)
            except ValueError:
                trusted = False
            if trusted:
                # Railway supplies X-Real-IP. Never select a caller's X-Forwarded-For.
                addresses = [
                    value for key, value in scope["headers"] if key == b"x-real-ip"
                ]
                try:
                    address = (
                        ip_address(addresses[0].decode("ascii").strip())
                        if len(addresses) == 1
                        else None
                    )
                except (ValueError, UnicodeDecodeError):
                    address = None
                if address is not None:
                    scope = {**scope, "client": (str(address), 0)}
                    protocols = [
                        value
                        for key, value in scope["headers"]
                        if key == b"x-forwarded-proto"
                    ]
                    if protocols == [b"https"]:
                        scope["scheme"] = (
                            "wss" if scope["type"] == "websocket" else "https"
                        )
        await self.app(scope, receive, send)
