"""ISO 4217 currency table (static data, no I/O beyond reading the bundled JSON once).

``data/currencies.json`` is a byte-identical copy of the repo's ``shared/currencies.json``
(the frontend reads the shared one); a test keeps them in sync. The copy exists because
the production image is built from ``backend/`` only.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cache
from pathlib import Path

_DATA = Path(__file__).with_name("data") / "currencies.json"


@dataclass(frozen=True)
class CurrencyInfo:
    code: str
    exponent: int  # minor-unit digits: 0 (JPY), 2 (SGD), 3 (KWD)
    symbol: str
    name: str


class UnknownCurrency(ValueError):
    pass


@cache
def currencies() -> dict[str, CurrencyInfo]:
    doc = json.loads(_DATA.read_text(encoding="utf-8"))
    return {c["code"]: CurrencyInfo(c["code"], int(c["exponent"]), c["symbol"], c["name"]) for c in doc["currencies"]}


def is_currency(code: str) -> bool:
    return code in currencies()


def currency(code: str) -> CurrencyInfo:
    try:
        return currencies()[code]
    except KeyError:
        raise UnknownCurrency(f"unknown currency {code!r}") from None


def exponent(code: str) -> int:
    """Minor-unit digits of ``code`` (raises UnknownCurrency)."""
    return currency(code).exponent


def normalize_code(value: object) -> str | None:
    """``" myr "`` → ``"MYR"``; anything that isn't a known ISO code → None."""
    if not isinstance(value, str):
        return None
    code = value.strip().upper()
    return code if is_currency(code) else None
