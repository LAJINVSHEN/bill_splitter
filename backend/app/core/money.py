"""Money helpers. PURE: no I/O, no framework imports.

**Every ``*_cents`` amount is an integer in MINOR UNITS of its currency** – cents for SGD
(exponent 2), whole yen for JPY (exponent 0), fils (1/1000) for KWD (exponent 3). The
historical ``_cents`` names are kept to avoid churn. The exponent comes from
``core/currencies.py`` (``shared/currencies.json``).

Proportional maths uses ``Decimal`` with ``ROUND_HALF_UP`` (half away from zero).
"""

from __future__ import annotations

from collections.abc import Sequence
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

CENT = Decimal("0.01")


def round_half_up(value: Decimal) -> int:
    """Round a Decimal to the nearest integer, halves away from zero."""
    return int(value.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _to_decimal(amount: Decimal | int | float | str) -> Decimal:
    if isinstance(amount, bool):
        raise TypeError("bool is not an amount")
    if isinstance(amount, float):
        amount = str(amount)  # 0.1 means 0.1, not its binary approximation
    try:
        dec = Decimal(amount)
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"not a number: {amount!r}") from exc
    if not dec.is_finite():
        raise ValueError(f"not a finite amount: {amount!r}")
    return dec


def to_cents(amount: Decimal | int | float | str, exponent: int = 2) -> int:
    """Major units → integer minor units of a currency with ``exponent`` digits, half-up.

    ``to_cents("12.345")`` → 1235 (SGD), ``to_cents("1200", 0)`` → 1200 (JPY),
    ``to_cents("1.2345", 3)`` → 1235 (KWD).
    """
    return round_half_up(_to_decimal(amount).scaleb(exponent))


def parse_major(text: str, exponent: int = 2) -> int:
    """Strict user-input parsing: ``"12.30"`` → 1230; rejects more decimals than the
    currency has (``"12.345"`` for SGD) instead of silently rounding."""
    dec = _to_decimal(text.strip().replace(",", ""))
    scaled = dec.scaleb(exponent)
    if scaled != scaled.to_integral_value():
        raise ValueError(f"{text!r} has more than {exponent} decimal place(s)")
    return int(scaled)


def cents_to_decimal(cents: int, exponent: int = 2) -> Decimal:
    return Decimal(cents).scaleb(-exponent).quantize(Decimal(1).scaleb(-exponent))


def format_cents(cents: int, exponent: int = 2) -> str:
    """``1234`` → ``"12.34"`` (2 dp); ``1234, 0`` → ``"1234"``; ``-5, 3`` → ``"-0.005"``."""
    return f"{cents_to_decimal(cents, exponent):f}"


def tolerance_minor(exponent: int, major: Decimal = Decimal("0.05")) -> int:
    """A tolerance of ``major`` units in minor units, never below 1:
    0.05 → 5 (SGD), 1 (JPY: 0.05 yen rounds to 0, floored at 1), 50 (KWD)."""
    return max(1, round_half_up(major.scaleb(exponent)))


def allocate(total_cents: int, weights: Sequence[Decimal | int]) -> list[int]:
    """Split ``total_cents`` proportionally to ``weights``.

    The rule (shared with the frontend mirror and ``shared/split-vectors.json``):

    1. each share = ROUND_HALF_UP(total × weight / Σweights) (0 when Σweights is 0);
    2. the rounding remainder ``total − Σshares`` is added to the **largest** share
       (the first one on ties).

    The result always sums exactly to ``total_cents``.
    """
    n = len(weights)
    if n == 0:
        return []
    dec_weights = [Decimal(w) for w in weights]
    weight_sum = sum(dec_weights, Decimal(0))
    if weight_sum == 0:
        shares = [0] * n
    else:
        total = Decimal(total_cents)
        shares = [round_half_up(total * w / weight_sum) for w in dec_weights]
    remainder = total_cents - sum(shares)
    if remainder:
        largest = max(range(n), key=lambda i: (shares[i], -i))
        shares[largest] += remainder
    return shares


def convert_minor(amount_minor: int, rate: Decimal, from_exponent: int, to_exponent: int) -> int:
    """Convert minor units with a user-entered rate (1 unit of FROM = ``rate`` units of TO):
    ROUND_HALF_UP(amount × rate × 10^(to_exp − from_exp))."""
    return round_half_up(Decimal(amount_minor) * rate * Decimal(1).scaleb(to_exponent - from_exponent))


def convert_allocation(grand_total_minor: int, shares_minor: Sequence[int], rate: Decimal, from_exponent: int,
                       to_exponent: int) -> tuple[int, list[int]]:
    """Converted grand total, then ``allocate`` it over the per-person bill-currency shares,
    so the converted shares sum exactly to the converted total."""
    total = convert_minor(grand_total_minor, rate, from_exponent, to_exponent)
    return total, allocate(total, list(shares_minor))
