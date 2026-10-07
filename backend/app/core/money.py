"""Money helpers. PURE: no I/O, no framework imports.

Money is integer **cents** everywhere; proportional maths uses ``Decimal`` with
``ROUND_HALF_UP`` (half away from zero).
"""

from __future__ import annotations

from collections.abc import Sequence
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

CENT = Decimal("0.01")


def round_half_up(value: Decimal) -> int:
    """Round a Decimal to the nearest integer, halves away from zero."""
    return int(value.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def to_cents(amount: Decimal | int | float | str) -> int:
    """Convert a major-unit amount (e.g. ``12.345``) to integer cents, half-up.

    Floats are converted through ``str`` so ``0.1`` means 0.1, not its binary
    approximation.
    """
    if isinstance(amount, bool):
        raise TypeError("bool is not an amount")
    if isinstance(amount, float):
        amount = str(amount)
    try:
        dec = Decimal(amount)
    except (InvalidOperation, ValueError) as exc:  # pragma: no cover - defensive
        raise ValueError(f"not a number: {amount!r}") from exc
    if not dec.is_finite():
        raise ValueError(f"not a finite amount: {amount!r}")
    return round_half_up(dec * 100)


def cents_to_decimal(cents: int) -> Decimal:
    return (Decimal(cents) / 100).quantize(CENT)


def format_cents(cents: int) -> str:
    """``1234`` → ``"12.34"``; ``-5`` → ``"-0.05"``."""
    return f"{cents_to_decimal(cents):.2f}"


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
