"""Calendar-month windows in the app timezone. PURE."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

_MONTH_RE = re.compile(r"^(\d{4})-(\d{2})$")


def month_key(now: datetime, tz: str) -> str:
    local = now.astimezone(ZoneInfo(tz))
    return f"{local.year:04d}-{local.month:02d}"


def parse_month(month: str) -> tuple[int, int]:
    m = _MONTH_RE.match(month)
    if not m or not 1 <= int(m.group(2)) <= 12:
        raise ValueError("month must look like YYYY-MM")
    return int(m.group(1)), int(m.group(2))


def month_bounds(month: str, tz: str) -> tuple[datetime, datetime]:
    """[start, end) of ``YYYY-MM`` in ``tz``, returned as aware UTC datetimes."""
    year, mon = parse_month(month)
    zone = ZoneInfo(tz)
    start = datetime(year, mon, 1, tzinfo=zone)
    end = datetime(year + (mon == 12), 1 if mon == 12 else mon + 1, 1, tzinfo=zone)
    return start.astimezone(UTC), end.astimezone(UTC)


def current_month_bounds(now: datetime, tz: str) -> tuple[str, datetime, datetime]:
    key = month_key(now, tz)
    start, end = month_bounds(key, tz)
    return key, start, end
