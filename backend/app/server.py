"""Use the same bounded WebSocket transport in development, CI, and Docker."""

import argparse
import os

import uvicorn

from app.websocket.limits import MAX_MESSAGE_BYTES


def server_config(host: str, port: int) -> uvicorn.Config:
    return uvicorn.Config(
        "app.main:app",
        host=host,
        port=port,
        workers=1,
        ws="websockets",
        ws_max_size=MAX_MESSAGE_BYTES,
        ws_max_queue=16,
        ws_per_message_deflate=False,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    args = parser.parse_args()
    uvicorn.Server(server_config(args.host, args.port)).run()


if __name__ == "__main__":
    main()
