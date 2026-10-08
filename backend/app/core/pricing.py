"""LLM cost estimates. PURE.

Prices are USD per 1M tokens, which is numerically **micro-USD per token**, so
``cost_micros = Σ tokens × price`` with no scaling.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol

from app.core.money import round_half_up


class PriceLike(Protocol):
    input: Decimal
    output: Decimal
    cached_input: Decimal | None


@dataclass(frozen=True)
class Price:
    input: Decimal
    output: Decimal
    cached_input: Decimal | None = None


def resolve_price(model: str, table: Mapping[str, PriceLike]) -> PriceLike | None:
    """Exact match, else the longest table key that prefixes ``model`` (dated snapshots)."""
    if model in table:
        return table[model]
    candidates = [k for k in table if model.startswith(k + "-")]
    return table[max(candidates, key=len)] if candidates else None


def most_expensive(table: Mapping[str, PriceLike]) -> PriceLike:
    return max(table.values(), key=lambda p: (p.output, p.input))


def cost_micros(input_tokens: int, output_tokens: int, price: PriceLike, cached_input_tokens: int = 0) -> int:
    """Estimated cost in micro-USD. Cached input tokens are a subset of input tokens."""
    cached = max(0, min(cached_input_tokens, input_tokens))
    cached_price = price.cached_input if price.cached_input is not None else price.input
    total = (
        Decimal(input_tokens - cached) * price.input
        + Decimal(cached) * cached_price
        + Decimal(output_tokens) * price.output
    )
    return round_half_up(total)


def estimate_cost_micros(model: str, input_tokens: int, output_tokens: int,
                         table: Mapping[str, PriceLike], cached_input_tokens: int = 0) -> tuple[int, bool]:
    """Returns (cost_micros, price_known). Unknown models are priced at the table's
    most expensive entry so budget caps stay conservative."""
    price = resolve_price(model, table)
    known = price is not None
    if price is None:
        if not table:
            return 0, False
        price = most_expensive(table)
    return cost_micros(input_tokens, output_tokens, price, cached_input_tokens), known


def max_call_cost_micros(model: str, max_input_tokens: int, max_output_tokens: int, attempts: int,
                         table: Mapping[str, PriceLike]) -> int | None:
    """Worst-case cost of one model call, for reserving budget BEFORE it is made: every input
    token at the uncached price, the full output allowance (reasoning tokens included), times
    the number of attempts the SDK may make. Unknown models use the most expensive price;
    an empty table can't bound anything (None)."""
    if not table:
        return None
    price = resolve_price(model, table) or most_expensive(table)
    return cost_micros(max_input_tokens, max_output_tokens, price) * max(attempts, 1)
