"""Folding unpriced receipt lines into the priced item they belong to. PURE.

Receipts list bundle components and modifiers ("2pc Chicken Tenders", "No Add Ons",
"Less ice") on their own lines with a blank or 0.00 price. The model faithfully returns
them as items, but they are not things to split: they add nothing to any total and only
clutter assignment. After extraction each such line is attached to the nearest priced
item above it (or, for lines before the first priced item, the first one below) as a
``details`` note. Totals, validation and the prompt are untouched.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import replace
from decimal import Decimal

from app.core.receipt_validation import ReceiptItem

MAX_DETAILS_LEN = 500

# "(included)", "(bundle item)", "(included in bundle)", "(incl.)" – annotations the model
# adds to components; dropped so a component listed twice reads once.
_ANNOTATION_RE = re.compile(r"\s*\((?:included(?: in (?:bundle|set|meal))?|incl\.?|bundle item|set item)\)", re.I)


def is_unpriced(item: ReceiptItem) -> bool:
    return item.total_price_cents == 0


def _label(item: ReceiptItem) -> str:
    name = _ANNOTATION_RE.sub("", item.name).strip() or item.name.strip()
    if item.quantity in (Decimal(0), Decimal(1)):
        return name
    return f"{name} ×{item.quantity.normalize():f}"


def join_details(parts: Sequence[str]) -> str | None:
    seen: set[str] = set()
    unique: list[str] = []
    for part in parts:
        key = part.casefold()
        if part and key not in seen:
            seen.add(key)
            unique.append(part)
    text = ", ".join(unique)
    if len(text) > MAX_DETAILS_LEN:
        text = text[: MAX_DETAILS_LEN - 1].rstrip(", ") + "…"
    return text or None


def fold_unpriced_items(items: Sequence[ReceiptItem]) -> list[ReceiptItem]:
    """Return ``items`` with every 0-total line folded into a priced neighbour's ``details``.

    Receipt order is kept. With no priced item at all nothing is folded (there is no
    parent, and dropping everything would leave an empty bill)."""
    priced_idx = [i for i, it in enumerate(items) if not is_unpriced(it)]
    if not priced_idx or len(priced_idx) == len(items):
        return list(items)
    attached: dict[int, list[str]] = {i: [] for i in priced_idx}
    first = priced_idx[0]
    parent: int | None = None
    for i, it in enumerate(items):
        if not is_unpriced(it):
            parent = i
            continue
        attached[parent if parent is not None else first].append(_label(it))
    out: list[ReceiptItem] = []
    for i in priced_idx:
        it = items[i]
        parts = ([it.details] if it.details else []) + attached[i]
        out.append(replace(it, details=join_details(parts)))
    return out
