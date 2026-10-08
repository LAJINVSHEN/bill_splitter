"""Request body size limit (pure ASGI, so it also covers chunked uploads)."""

from __future__ import annotations

from collections.abc import Callable

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.errors import error_body


class BodyTooLarge(Exception):
    pass


def _too_large(limit: int) -> JSONResponse:
    return JSONResponse(
        error_body("payload_too_large", f"Request body is larger than {limit // 1024} KB.", limit_bytes=limit),
        status_code=413,
    )


class BodySizeLimitMiddleware:
    """Rejects bodies over ``limit_for(method, path)`` bytes with a JSON 413.

    Declared Content-Length is checked up front; streamed bodies are counted as they are
    read, and whatever response the app tries to send after the limit trips is replaced.
    """

    def __init__(self, app: ASGIApp, limit_for: Callable[[str, str], int]) -> None:
        self.app = app
        self.limit_for = limit_for

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] in ("GET", "HEAD", "OPTIONS"):
            await self.app(scope, receive, send)
            return
        limit = self.limit_for(scope["method"], scope["path"])
        for name, value in scope.get("headers", []):
            if name == b"content-length":
                if value.isdigit() and int(value) > limit:
                    await _too_large(limit)(scope, receive, send)
                    return
                break

        received = 0
        exceeded = False
        replied = False

        async def _receive() -> Message:
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    exceeded = True
                    raise BodyTooLarge
            return message

        async def _send(message: Message) -> None:
            nonlocal replied
            if exceeded:
                if not replied:
                    replied = True
                    await _too_large(limit)(scope, receive, send)
                return
            await send(message)

        try:
            await self.app(scope, _receive, _send)
        except BodyTooLarge:
            pass
        if exceeded and not replied:
            await _too_large(limit)(scope, receive, send)
