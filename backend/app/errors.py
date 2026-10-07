"""Error envelope + exception handlers.

Every error response has the shape ``{"detail": "<human message>", "code": "<machine code>", ...}``.
422s add ``errors`` (field-level list). Handlers run inside the CORS middleware, so
error responses keep their CORS headers.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger("app.errors")


class AppError(Exception):
    def __init__(self, status_code: int, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.extra = extra


class NotFound(AppError):
    def __init__(self, what: str = "Resource") -> None:
        super().__init__(404, "not_found", f"{what} not found")


class Conflict(AppError):
    def __init__(self, code: str, message: str, **extra: Any) -> None:
        super().__init__(409, code, message, **extra)


class BadRequest(AppError):
    def __init__(self, code: str, message: str, **extra: Any) -> None:
        super().__init__(400, code, message, **extra)


def error_body(code: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"detail": message, "code": code, **extra}


def _jsonable_errors(exc: RequestValidationError) -> list[dict[str, Any]]:
    out = []
    for err in exc.errors():
        out.append({
            "loc": [str(p) for p in err.get("loc", ())],
            "msg": str(err.get("msg", "")),
            "type": str(err.get("type", "")),
        })
    return out


def install_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        headers = {"Retry-After": str(exc.extra["retry_after"])} if "retry_after" in exc.extra else None
        return JSONResponse(error_body(exc.code, exc.message, **exc.extra), status_code=exc.status_code,
                            headers=headers)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            error_body("validation_error", "Some fields are invalid.", errors=_jsonable_errors(exc)),
            status_code=422,
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, str) else "Request failed"
        return JSONResponse(error_body(f"http_{exc.status_code}", detail), status_code=exc.status_code,
                            headers=getattr(exc, "headers", None))


class CatchAllMiddleware:
    """Turns unhandled exceptions into a JSON 500 *inside* the CORS middleware.

    Starlette's own 500 handling lives in the outermost ServerErrorMiddleware, which is
    outside CORSMiddleware, so browsers would see an opaque CORS failure instead of a 500.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def _send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, _send)
        except Exception:
            logger.exception("Unhandled error on %s %s", scope.get("method"), scope.get("path"))
            if started:
                raise
            response = JSONResponse(error_body("internal_error", "Something went wrong on our side."),
                                    status_code=500)
            await response(scope, receive, send)
