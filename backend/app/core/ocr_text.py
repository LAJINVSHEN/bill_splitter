"""Joining OCR output from several files/pages into one LLM input. PURE."""

from __future__ import annotations

import re
from collections.abc import Sequence

# Azure DI's markdown separates PDF pages with this comment.
_PAGE_BREAK_RE = re.compile(r"\s*<!--\s*PageBreak\s*-->\s*", re.IGNORECASE)


def split_pages(markdown: str) -> list[str]:
    parts = [p.strip() for p in _PAGE_BREAK_RE.split(markdown or "")]
    return [p for p in parts if p] or [""]


def join_pages(file_texts: Sequence[str]) -> str:
    """Join per-file markdown into one text with explicit page markers.

    Every physical page (one photo, or one page of a PDF) gets a
    ``--- Page i of N ---`` header so the model knows where photos start/end.
    A single one-page receipt is returned unchanged (no marker noise).
    """
    pages = [page for text in file_texts for page in split_pages(text)]
    pages = [p for p in pages if p.strip()]
    if len(pages) <= 1:
        return pages[0] if pages else ""
    total = len(pages)
    return "\n\n".join(f"--- Page {i} of {total} ---\n{page}" for i, page in enumerate(pages, start=1))
