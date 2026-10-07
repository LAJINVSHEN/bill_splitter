"""Async OpenAI wrapper for receipt extraction (structured outputs).

The system prompt, user prompt and schema are the original ones from
``openai_service.py``. Model choice/escalation lives in ``services.extraction``; this
module makes exactly one model call and reports tokens, latency, model and cost –
also when the call fails, so usage is always recorded.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Protocol

from app.config import ModelPrice, Settings
from app.core.pricing import estimate_cost_micros
from app.schemas.extraction import ReceiptExtraction

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are a receipt data extraction expert. Extract information with these rules:

CRITICAL RULES:
1. grand_total is MANDATORY - the final amount payable
2. Extract ALL taxes, charges, discounts into taxes_or_charges (negative for discounts)
3. subtotal: Use receipt value if shown, else 0.00 (DO NOT calculate)
4. DO NOT perform calculations - extract amounts exactly as shown
5. Extract ALL items, don't miss any

Return JSON format only, no markdown or explanations."""

USER_PROMPT_TEMPLATE = """Extract receipt data from this text:

{raw_text}

Return structured JSON according to the schema."""


@dataclass(frozen=True)
class LlmCall:
    requested_model: str
    model: str  # as reported by the API (dated snapshot) when available
    ok: bool
    extraction: ReceiptExtraction | None = None
    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
    latency_ms: int = 0
    cost_micros: int = 0
    price_known: bool = True
    error_code: str | None = None
    error_message: str | None = None


class LlmClient(Protocol):
    provider: str

    async def extract_receipt(self, text: str, model: str, reasoning_effort: str | None) -> LlmCall: ...
    async def aclose(self) -> None: ...


def build_messages(raw_text: str) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": USER_PROMPT_TEMPLATE.format(raw_text=raw_text)},
    ]


class OpenAIReceiptExtractor:
    provider = "openai"

    def __init__(self, api_key: str, *, timeout_seconds: float, max_retries: int, max_output_tokens: int,
                 prices: Mapping[str, ModelPrice]) -> None:
        from openai import AsyncOpenAI

        self.client = AsyncOpenAI(api_key=api_key, timeout=timeout_seconds, max_retries=max_retries)
        self.max_output_tokens = max_output_tokens
        self.prices = prices
        # Hard ceiling across the SDK's own retries.
        self.deadline = timeout_seconds * (max_retries + 1) + 5

    def _result(self, requested: str, started: float, *, completion: object | None = None, ok: bool,
                extraction: ReceiptExtraction | None = None, error_code: str | None = None,
                error_message: str | None = None) -> LlmCall:
        usage = getattr(completion, "usage", None)
        input_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
        output_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
        details = getattr(usage, "prompt_tokens_details", None)
        cached = int(getattr(details, "cached_tokens", 0) or 0)
        model = str(getattr(completion, "model", "") or requested)
        cost, known = estimate_cost_micros(requested, input_tokens, output_tokens, self.prices, cached)
        return LlmCall(
            requested_model=requested, model=model, ok=ok, extraction=extraction, input_tokens=input_tokens,
            cached_input_tokens=cached, output_tokens=output_tokens,
            latency_ms=int((time.perf_counter() - started) * 1000), cost_micros=cost, price_known=known,
            error_code=error_code, error_message=error_message,
        )

    async def extract_receipt(self, text: str, model: str, reasoning_effort: str | None) -> LlmCall:
        import openai

        kwargs: dict[str, object] = {
            "model": model,
            "messages": build_messages(text),
            "response_format": ReceiptExtraction,
            "max_completion_tokens": self.max_output_tokens,
        }
        if reasoning_effort:
            kwargs["reasoning_effort"] = reasoning_effort
        started = time.perf_counter()
        try:
            async with asyncio.timeout(self.deadline):
                completion = await self.client.chat.completions.parse(**kwargs)  # type: ignore[call-overload]
        except (TimeoutError, openai.APITimeoutError):
            return self._result(model, started, ok=False, error_code="llm_timeout",
                                error_message="The model took too long to answer.")
        except openai.LengthFinishReasonError as exc:
            return self._result(model, started, completion=getattr(exc, "completion", None), ok=False,
                                error_code="llm_truncated", error_message="The model ran out of output tokens.")
        except openai.ContentFilterFinishReasonError:
            return self._result(model, started, ok=False, error_code="llm_refused",
                                error_message="The model refused to read this receipt.")
        except openai.RateLimitError:
            return self._result(model, started, ok=False, error_code="llm_rate_limited",
                                error_message="OpenAI rate limit or quota reached.")
        except openai.APIStatusError as exc:
            return self._result(model, started, ok=False, error_code=f"llm_http_{exc.status_code}",
                                error_message=f"OpenAI returned HTTP {exc.status_code}.")
        except openai.APIConnectionError:
            return self._result(model, started, ok=False, error_code="llm_connection",
                                error_message="Couldn't reach OpenAI.")
        except openai.OpenAIError as exc:  # e.g. schema/parse errors raised by the SDK
            logger.warning("LLM call failed: %s", type(exc).__name__)
            return self._result(model, started, ok=False, error_code="llm_error",
                                error_message="The model returned something unreadable.")

        message = completion.choices[0].message
        if getattr(message, "refusal", None):
            return self._result(model, started, completion=completion, ok=False, error_code="llm_refused",
                                error_message="The model refused to read this receipt.")
        if message.parsed is None:
            return self._result(model, started, completion=completion, ok=False, error_code="llm_empty",
                                error_message="The model returned no data.")
        return self._result(model, started, completion=completion, ok=True, extraction=message.parsed)

    async def aclose(self) -> None:
        await self.client.close()


@dataclass
class FakeLlmClient:
    """Scripted LLM for tests/dev. ``script[model]`` is a queue of ReceiptExtraction
    objects or error codes (str); when empty, ``default`` is returned."""

    provider: str = "fake"
    script: dict[str, list[ReceiptExtraction | str]] = field(default_factory=dict)
    default: ReceiptExtraction | None = None
    delay: float = 0.0
    calls: list[str] = field(default_factory=list)
    input_tokens: int = 1000
    output_tokens: int = 200

    async def extract_receipt(self, text: str, model: str, reasoning_effort: str | None) -> LlmCall:
        self.calls.append(model)
        if self.delay:
            await asyncio.sleep(self.delay)
        queue = self.script.get(model) or []
        outcome: ReceiptExtraction | str | None = queue.pop(0) if queue else self.default
        if outcome is None:
            outcome = "llm_empty"
        if isinstance(outcome, str):
            return LlmCall(requested_model=model, model=model, ok=False, error_code=outcome,
                           error_message=f"fake failure: {outcome}", input_tokens=self.input_tokens,
                           latency_ms=3, cost_micros=self.input_tokens)
        return LlmCall(requested_model=model, model=model, ok=True, extraction=outcome,
                       input_tokens=self.input_tokens, output_tokens=self.output_tokens, latency_ms=3,
                       cost_micros=self.input_tokens + self.output_tokens * 4)

    async def aclose(self) -> None:
        return None


class UnavailableLlmClient:
    provider = "openai"

    async def extract_receipt(self, text: str, model: str, reasoning_effort: str | None) -> LlmCall:
        return LlmCall(requested_model=model, model=model, ok=False, error_code="llm_not_configured",
                       error_message="OpenAI is not configured.")

    async def aclose(self) -> None:
        return None


def build_llm(settings: Settings) -> LlmClient:
    if settings.llm_backend == "fake":
        return FakeLlmClient()
    if not settings.openai_api_key:
        logger.warning("LLM disabled: OPENAI_API_KEY is not set")
        return UnavailableLlmClient()
    return OpenAIReceiptExtractor(settings.openai_api_key, timeout_seconds=settings.llm_timeout_seconds,
                                  max_retries=settings.llm_max_retries,
                                  max_output_tokens=settings.llm_max_output_tokens, prices=settings.llm_prices)
