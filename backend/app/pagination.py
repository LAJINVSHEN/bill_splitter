"""Opaque keyset cursors: base64url(JSON list of the last row's sort keys)."""

from __future__ import annotations

import base64
import json
from datetime import datetime
from typing import Any
from uuid import UUID

from app.errors import BadRequest


def encode_cursor(*values: Any) -> str:
    def enc(v: Any) -> Any:
        if isinstance(v, datetime):
            return {"t": v.isoformat()}
        if isinstance(v, UUID):
            return {"u": str(v)}
        return v

    raw = json.dumps([enc(v) for v in values], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str, arity: int) -> list[Any]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        values = json.loads(raw)
        if not isinstance(values, list) or len(values) != arity:
            raise ValueError

        def dec(v: Any) -> Any:
            if isinstance(v, dict) and "t" in v:
                return datetime.fromisoformat(v["t"])
            if isinstance(v, dict) and "u" in v:
                return UUID(v["u"])
            return v

        return [dec(v) for v in values]
    except (ValueError, TypeError, json.JSONDecodeError):
        raise BadRequest("invalid_cursor", "The pagination cursor is invalid.") from None
