#!/usr/bin/env python
"""Benchmark receipt-extraction models on real receipt photos (P4a).

The production flow is reproduced with the app's own code:

    photo → preprocess like the web client (EXIF orientation applied, long edge ≤ 2000 px,
            JPEG quality ≈ 0.8)
          → Azure DI ``prebuilt-layout`` → markdown          (app.integrations.azure_ocr)
          → OpenAI structured extraction, one configuration  (app.integrations.llm)
            at a time, or the primary → fallback chain       (app.services.extraction)
          → totals reconciliation                            (app.services.extraction.validate_extraction)

PRIVACY: receipts are personal data. Everything this script writes (processed images,
OCR text, raw extractions, the per-receipt report) goes under ``.local/benchmark/``
(gitignored) unless ``--out`` says otherwise. Only ``aggregate.md`` is free of receipt
content (no merchant, item, amount or file name) and safe to quote.

Guards (both counted across runs from ledgers in the output directory, so re-running
never silently doubles the spend):
  * Azure: ``--max-pages`` hard cap on pages analysed, ``--ocr-interval`` (>= 4) seconds
    between submissions, and the app's own F0 request limiter (``AZURE_DI_CALLS_PER_MINUTE``
    on every POST/poll/retry; a 429 pauses all requests). One attempt per file per run: a
    service-level failure stops the OCR stage instead of retrying.
  * OpenAI: ``--budget-usd`` hard cap, priced with the app's price table
    (``Settings.llm_prices``); a conservative estimate is reserved before every call and
    the run stops when the next call might not fit.

Everything is cached (OCR per image SHA-256, extraction per configuration × receipt),
so re-runs only do missing work; ``--stages report`` rebuilds the report for free.

Configurations are ``model@effort`` (``gpt-6-luna@low``), ``model`` alone for models
without reasoning effort (``gpt-4o``), and ``primary@effort>fallback@effort`` for the
production escalation chain (fallback only when the primary errors or its output
doesn't reconcile).

Optional private inputs in the output directory:
  * ``groups.json``       ``{"<group-id>": ["<sha>", "<sha>"]}`` – photos of one receipt;
                          their OCR texts are joined with the app's page markers and
                          benchmarked as one multi-photo receipt.
  * ``adjudication.json`` ``{"<sha-or-group>": {"grand_total": 12.3, "items": 4,
                          "items_sum": 11.2, "notes": "...", "failures": {"<config>": ["missed_items"]}}}``
                          – hand-checked truth that overrides the consensus for that receipt
                          and manual failure categories that replace the automatic tags.

Run from the repo root (the ``api`` service carries the keys and mounts ``.local``):

    docker compose run --rm --no-deps api sh -c \\
        "pip install -q pillow && python scripts/benchmark_llm.py --input uploads"

    # report only (no API calls):
    docker compose run --rm --no-deps api python scripts/benchmark_llm.py --stages report
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.util
import io
import json
import math
import re
import sys
import time
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

BACKEND = Path(__file__).resolve().parents[1]
if importlib.util.find_spec("app") is None:  # allow PYTHONPATH to point at a snapshot of the app
    sys.path.insert(0, str(BACKEND))

from app.config import Settings, get_settings  # noqa: E402
from app.core.ocr_text import join_pages  # noqa: E402
from app.core.pricing import resolve_price  # noqa: E402
from app.integrations.azure_ocr import AzureOcrClient, OcrError  # noqa: E402
from app.integrations.llm import SYSTEM_PROMPT, USER_PROMPT_TEMPLATE, LlmCall, OpenAIReceiptExtractor  # noqa: E402
from app.schemas.extraction import ReceiptExtraction  # noqa: E402
from app.services.extraction import extract_with_escalation, validate_extraction  # noqa: E402

REPO_ROOT = BACKEND.parent
DEFAULT_OUT = REPO_ROOT / ".local" / "benchmark"
# gpt-6.1-sol rejects reasoning_effort "none" (HTTP 400, checked 2026-10-07); its lowest is "low".
DEFAULT_CONFIGS = "gpt-6-luna@none,gpt-6-luna@low,gpt-6.1-sol@low,gpt-4o"
DEFAULT_CHAIN = "gpt-6-luna@low>gpt-6.1-sol@low"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".bmp", ".tif", ".tiff"}
TOLERANCE_CENTS = 5
_DISCOUNT_RE = re.compile(r"discount|promo|voucher|coupon|rebate|member|\boff\b|less", re.I)
_POSITIVE_CHARGE_RE = re.compile(r"service|svc|gst|sst|vat|tax", re.I)


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return default


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str), "utf-8")
    tmp.replace(path)


def append_jsonl(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text("utf-8").splitlines() if line.strip()]


def pct(n: int, d: int) -> str:
    return f"{100 * n / d:.0f}%" if d else "–"


def percentile(values: Iterable[float], p: float) -> float | None:
    """Nearest-rank percentile (no interpolation; honest for small samples)."""
    s = sorted(values)
    if not s:
        return None
    k = max(0, math.ceil(p / 100 * len(s)) - 1)
    return s[k]


def secs(ms: float | None) -> str:
    return "–" if ms is None else f"{ms / 1000:.1f}s"


def money(cents: int | None) -> str:
    return "–" if cents is None else f"{cents / 100:.2f}"


# ----------------------------------------------------------------------------- configurations
@dataclass(frozen=True)
class Config:
    spec: str
    steps: tuple[tuple[str, str | None], ...]

    @property
    def id(self) -> str:
        return re.sub(r"[^A-Za-z0-9.@>_-]", "_", self.spec).replace(">", "__then__").replace("@", "_")

    @property
    def is_chain(self) -> bool:
        return len(self.steps) > 1

    @property
    def label(self) -> str:
        parts = [f"{m} ({e})" if e else m for m, e in self.steps]
        return " → ".join(parts)


def parse_config(spec: str) -> Config:
    steps: list[tuple[str, str | None]] = []
    for part in spec.strip().split(">"):
        model, _, effort = part.strip().partition("@")
        effort = effort.strip()
        steps.append((model.strip(), effort if effort and effort != "-" else None))
    if not steps or not all(m for m, _ in steps):
        raise SystemExit(f"bad configuration: {spec!r}")
    return Config(spec.strip(), tuple(steps))


# ----------------------------------------------------------------------------- stage 1: preprocess
def preprocess_image(data: bytes, max_edge: int, quality: int) -> tuple[bytes, dict[str, Any]]:
    """What the client will do: apply EXIF orientation, fit the long edge, JPEG q≈0.8,
    no metadata (canvas.toBlob strips EXIF)."""
    try:
        from PIL import Image, ImageOps
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise SystemExit("Pillow is needed for preprocessing: pip install pillow") from exc
    with Image.open(io.BytesIO(data)) as raw:
        orientation = raw.getexif().get(0x0112, 1)
        orig_size = raw.size
        img = ImageOps.exif_transpose(raw)
        img = img.convert("RGB")
        img.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=quality)
        meta = {"orig_w": orig_size[0], "orig_h": orig_size[1], "exif_orientation": orientation,
                "w": img.size[0], "h": img.size[1]}
    return buf.getvalue(), meta


def stage_prep(input_dirs: list[Path], out: Path, max_edge: int, quality: int) -> list[dict[str, Any]]:
    files = sorted(p for d in input_dirs for p in d.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS)
    if not files:
        raise SystemExit(f"no images in {', '.join(map(str, input_dirs))}")
    manifest_path = out / "manifest.json"
    old = {e["sha"]: e for e in read_json(manifest_path, {"receipts": []})["receipts"]}
    receipts: dict[str, dict[str, Any]] = {}
    duplicates: dict[str, list[str]] = defaultdict(list)
    for path in files:
        data = path.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        duplicates[sha].append(path.name)
        if sha in receipts:
            continue
        img_path = out / "images" / f"{sha}.jpg"
        entry = old.get(sha)
        if entry is None or not img_path.exists():
            processed, meta = preprocess_image(data, max_edge, quality)
            img_path.parent.mkdir(parents=True, exist_ok=True)
            img_path.write_bytes(processed)
            entry = {"sha": sha, "source": path.name, "orig_bytes": len(data), "bytes": len(processed),
                     "processed_sha": hashlib.sha256(processed).hexdigest(), **meta}
        receipts[sha] = entry
    dups = {sha: names for sha, names in duplicates.items() if len(names) > 1}
    entries = list(receipts.values())
    write_json(manifest_path, {"created": now_iso(), "input_files": len(files), "unique": len(entries),
                               "max_edge": max_edge, "jpeg_quality": quality, "duplicates": dups,
                               "receipts": entries})
    sizes = [e["bytes"] for e in entries]
    log(f"prep: {len(files)} files → {len(entries)} unique ({len(files) - len(entries)} duplicates); "
        f"processed JPEG p50 {percentile(sizes, 50) / 1024:.0f} KB, max {max(sizes) / 1024:.0f} KB")
    return entries


def load_manifest(out: Path) -> list[dict[str, Any]]:
    manifest = read_json(out / "manifest.json")
    if not manifest:
        raise SystemExit("no manifest: run the prep stage first (--stages prep)")
    return manifest["receipts"]


# ----------------------------------------------------------------------------- stage 2: OCR
async def stage_ocr(entries: list[dict[str, Any]], out: Path, settings: Settings, max_pages: int,
                    interval: float) -> None:
    ledger_path = out / "azure_ledger.jsonl"
    pages_used = sum(int(r.get("pages", 0)) for r in read_jsonl(ledger_path))
    todo = [e for e in entries if not (out / "ocr" / f"{e['sha']}.md").exists()]
    log(f"ocr: {len(entries) - len(todo)} cached, {len(todo)} to analyse; pages used so far {pages_used}/{max_pages}")
    if not todo:
        return
    # Same F0 gate as the app (build_ocr): the per-retry request limiter takes a slot for the
    # analyze POST, every poll GET and every SDK retry, and a 429 pauses all requests. The
    # limiter is per process, so keep --ocr-interval generous when the API is also scanning.
    client = AzureOcrClient(settings.azure_di_endpoint, settings.azure_di_key, max_concurrency=1,
                            max_pdf_pages=settings.ocr_max_pdf_pages, timeout_seconds=settings.ocr_timeout_seconds,
                            calls_per_minute=settings.azure_calls_per_minute_effective,
                            rate_wait_seconds=settings.ocr_rate_wait_seconds,
                            poll_interval_seconds=settings.ocr_poll_interval_seconds)
    log(f"ocr: request limiter {client.limiter.limit}/min, poll every {client.poll_interval:.0f}s, "
        f"{interval:.0f}s between submissions")
    last_submit = 0.0
    try:
        for n, entry in enumerate(todo, start=1):
            if pages_used + 1 > max_pages:
                log(f"ocr: page cap reached ({pages_used}/{max_pages}); stopping")
                break
            data = (out / "images" / f"{entry['sha']}.jpg").read_bytes()
            wait = last_submit + interval - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            last_submit = time.monotonic()
            # One attempt per file per run, never a retry loop: a failure is recorded (a submitted
            # one counts as a billed page) and a re-run picks the file up again.
            try:
                result = await client.analyze(data, "image/jpeg")
            except OcrError as exc:
                billed = 1 if exc.submitted else 0
                pages_used += billed
                append_jsonl(ledger_path, {"at": now_iso(), "sha": entry["sha"], "ok": False, "code": exc.code,
                                           "pages": billed})
                log(f"ocr: {entry['sha'][:10]} failed: {exc.code} (billed {billed})")
                if exc.code != "ocr_rejected":  # anything not specific to this file: stop, don't hammer
                    log("ocr: stopping the OCR stage after a service-level failure")
                    break
                continue
            pages_used += result.pages
            append_jsonl(ledger_path, {"at": now_iso(), "sha": entry["sha"], "ok": True, "pages": result.pages,
                                       "latency_ms": result.latency_ms})
            (out / "ocr").mkdir(parents=True, exist_ok=True)
            (out / "ocr" / f"{entry['sha']}.md").write_text(result.text, "utf-8")
            write_json(out / "ocr" / f"{entry['sha']}.json",
                       {"latency_ms": result.latency_ms, "pages": result.pages, "bytes": len(data),
                        "chars": len(result.text), "at": now_iso()})
            log(f"ocr: [{n}/{len(todo)}] {entry['sha'][:10]} {result.latency_ms} ms, "
                f"{len(result.text)} chars (pages {pages_used}/{max_pages})")
    finally:
        log(f"ocr: {client.limiter.acquired} Azure requests made (POST + polls + retries)")
        await client.aclose()


def load_texts(entries: list[dict[str, Any]], out: Path) -> dict[str, str]:
    """Receipt id → OCR text (single photos by sha, plus multi-photo groups)."""
    texts: dict[str, str] = {}
    for e in entries:
        path = out / "ocr" / f"{e['sha']}.md"
        if path.exists():
            texts[e["sha"]] = path.read_text("utf-8")
    for gid, shas in (read_json(out / "groups.json", {}) or {}).items():
        if all(s in texts for s in shas):
            texts[f"group-{gid}"] = join_pages([texts[s] for s in shas])
    return texts


# ----------------------------------------------------------------------------- stage 3: LLM
class Budget:
    """OpenAI spend ledger with reservations (micro-USD)."""

    def __init__(self, path: Path, cap_micros: int) -> None:
        self.path = path
        self.cap = cap_micros
        self.spent = sum(int(r.get("cost_micros", 0)) for r in read_jsonl(path))
        self.reserved = 0
        self.max_output: dict[str, int] = defaultdict(int)

    def try_reserve(self, amount: int) -> bool:
        if self.spent + self.reserved + amount > self.cap:
            return False
        self.reserved += amount
        return True

    def settle(self, reserved: int, calls: list[LlmCall], config: str, receipt: str) -> None:
        self.reserved -= reserved
        for c in calls:
            self.spent += c.cost_micros
            self.max_output[c.requested_model] = max(self.max_output[c.requested_model], c.output_tokens)
            append_jsonl(self.path, {"at": now_iso(), "config": config, "receipt": receipt[:16],
                                     "model": c.requested_model, "ok": c.ok, "cost_micros": c.cost_micros,
                                     "input_tokens": c.input_tokens, "output_tokens": c.output_tokens})


def estimate_call_micros(settings: Settings, model: str, text: str, budget: Budget) -> int:
    """Deliberately pessimistic: ~2.5 chars/token for the prompt + schema overhead, and
    output at 1.5× the largest seen for the model (4,000 tokens before any is seen)."""
    price = resolve_price(model, settings.llm_prices) or max(settings.llm_prices.values(),
                                                             key=lambda p: (p.output, p.input))
    chars = len(SYSTEM_PROMPT) + len(USER_PROMPT_TEMPLATE) + len(text)
    tokens_in = int(chars / 2.5) + 800
    seen = budget.max_output.get(model, 0)
    tokens_out = min(settings.llm_max_output_tokens, int(seen * 1.5) if seen else 4000)
    return int(tokens_in * price.input + tokens_out * price.output) + 1


def call_dict(call: LlmCall, effort: str | None) -> dict[str, Any]:
    return {"requested_model": call.requested_model, "model": call.model, "effort": effort, "ok": call.ok,
            "error_code": call.error_code, "input_tokens": call.input_tokens,
            "cached_input_tokens": call.cached_input_tokens, "output_tokens": call.output_tokens,
            "latency_ms": call.latency_ms, "cost_micros": call.cost_micros, "price_known": call.price_known}


def validation_dict(x: ReceiptExtraction) -> dict[str, Any]:
    v = validate_extraction(x)
    return {"ok": v.ok, "tax_scenario": v.tax_scenario, "items_total_cents": v.items_total_cents,
            "charges_total_cents": v.charges_total_cents, "grand_total_cents": v.grand_total_cents,
            "provided_subtotal_cents": v.provided_subtotal_cents, "errors": [e.code for e in v.errors],
            "warnings": [w.item_index for w in v.warnings]}


async def run_one(llm: OpenAIReceiptExtractor, cfg: Config, text: str) -> dict[str, Any]:
    started = time.perf_counter()
    efforts = dict(cfg.steps)
    if cfg.is_chain:
        calls: list[LlmCall] = []

        async def on_call(call: LlmCall) -> None:
            calls.append(call)

        outcome = await extract_with_escalation(llm, text, [(m, e or "") for m, e in cfg.steps], on_call)
        extraction, model_used = outcome.extraction, outcome.model
    else:
        model, effort = cfg.steps[0]
        call = await llm.extract_receipt(text, model, effort)
        calls = [call]
        extraction, model_used = call.extraction, (call.model if call.ok else None)
    return {
        "config": cfg.spec, "at": now_iso(), "wall_ms": int((time.perf_counter() - started) * 1000),
        "calls": [call_dict(c, efforts.get(c.requested_model)) for c in calls],
        "escalated": len(calls) > 1, "model_used": model_used,
        "extraction": extraction.model_dump(mode="json") if extraction is not None else None,
        "validation": validation_dict(extraction) if extraction is not None else None,
        "latency_ms": sum(c.latency_ms for c in calls), "cost_micros": sum(c.cost_micros for c in calls),
    }


def run_path(out: Path, cfg: Config, rid: str, repeat: int) -> Path:
    return out / "runs" / cfg.id / (f"{rid}.json" if repeat == 1 else f"{rid}~{repeat}.json")


async def stage_llm(configs: list[Config], texts: dict[str, str], out: Path, settings: Settings,
                    budget: Budget, concurrency: int, repeats: int) -> None:
    llm = OpenAIReceiptExtractor(settings.openai_api_key, timeout_seconds=settings.llm_timeout_seconds,
                                 max_retries=settings.llm_max_retries,
                                 max_output_tokens=settings.llm_max_output_tokens, prices=settings.llm_prices)
    stop = False
    try:
        for repeat in range(1, max(1, repeats) + 1):
            for cfg in configs:
                todo = [rid for rid in texts if not run_path(out, cfg, rid, repeat).exists()]
                log(f"llm: {cfg.label} #{repeat}: {len(texts) - len(todo)} cached, {len(todo)} to run "
                    f"(spent ${budget.spent / 1e6:.3f} of ${budget.cap / 1e6:.2f})")
                sem = asyncio.Semaphore(max(1, concurrency))

                async def one(rid: str, cfg: Config = cfg, repeat: int = repeat) -> None:
                    nonlocal stop
                    async with sem:
                        if stop:
                            return
                        text = texts[rid]
                        estimate = sum(estimate_call_micros(settings, m, text, budget) for m, _ in cfg.steps)
                        if not budget.try_reserve(estimate):
                            stop = True
                            log(f"llm: budget guard – next call (≤ ${estimate / 1e6:.4f}) would exceed the cap; "
                                "stopping")
                            return
                        try:
                            record = await run_one(llm, cfg, text)
                        except BaseException:
                            budget.reserved -= estimate
                            raise
                        record["repeat"] = repeat
                        budget.settle(estimate, [_as_call(c) for c in record["calls"]], cfg.spec, rid)
                        write_json(run_path(out, cfg, rid, repeat), record)
                        v = record["validation"]
                        status = ("ok" if v and v["ok"] else (",".join(v["errors"]) if v else
                                  record["calls"][-1]["error_code"]))
                        log(f"llm: {cfg.id} #{repeat} {rid[:10]} {status} {record['latency_ms']} ms "
                            f"${record['cost_micros'] / 1e6:.4f}{' (escalated)' if record['escalated'] else ''}")

                await asyncio.gather(*(one(rid) for rid in todo))
                if stop:
                    break
            if stop:
                break
    finally:
        await llm.aclose()
    log(f"llm: total spent ${budget.spent / 1e6:.4f}")


def _as_call(d: dict[str, Any]) -> LlmCall:
    return LlmCall(requested_model=d["requested_model"], model=d["model"], ok=d["ok"],
                   input_tokens=d["input_tokens"], output_tokens=d["output_tokens"], cost_micros=d["cost_micros"])


# ----------------------------------------------------------------------------- stage 4: report
@dataclass
class Outcome:
    """One configuration's result on one receipt, reduced to what the metrics need."""

    record: dict[str, Any]

    @property
    def extraction(self) -> dict[str, Any] | None:
        return self.record.get("extraction")

    @property
    def ok(self) -> bool:
        v = self.record.get("validation")
        return bool(v and v["ok"])

    @property
    def status(self) -> str:
        v = self.record.get("validation")
        if v is None:
            return "error"
        return "succeeded" if v["ok"] else "needs_review"

    @property
    def key(self) -> tuple[int, int, int] | None:
        v, x = self.record.get("validation"), self.extraction
        if v is None or x is None:
            return None
        return (v["grand_total_cents"], len(x["items"]), v["items_total_cents"])


def norm_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()


def auto_tags(o: Outcome, ref_key: tuple[int, int, int] | None, ref: Outcome | None) -> list[str]:
    """Heuristic failure categories against the reference; refined by hand via adjudication.json."""
    if o.extraction is None:
        return [f"error:{o.record['calls'][-1]['error_code']}"]
    tags: list[str] = []
    x, v = o.extraction, o.record["validation"]
    gt, n, isum = o.key or (0, 0, 0)
    for c in x["taxes_or_charges"]:
        amount, name = float(c["amount"]), c["name"]
        if (amount > 0 and _DISCOUNT_RE.search(name) and not _POSITIVE_CHARGE_RE.search(name)) or (
                amount < 0 and _POSITIVE_CHARGE_RE.search(name) and not _DISCOUNT_RE.search(name)):
            tags.append("charge_sign")
            break
    if ref_key is not None:
        rgt, rn, risum = ref_key
        if n < rn:
            tags.append("missed_items")
        elif n > rn:
            names = Counter((norm_name(i["name"]), round(float(i["total_price"]), 2)) for i in x["items"])
            ref_names = Counter((norm_name(i["name"]), round(float(i["total_price"]), 2))
                                for i in (ref.extraction["items"] if ref and ref.extraction else []))
            dup = any(cnt > ref_names.get(k, 0) and ref_names.get(k, 0) >= 1 for k, cnt in names.items())
            tags.append("duplicated_items" if dup else "extra_items")
        if n == rn and abs(isum - risum) > TOLERANCE_CENTS:
            tags.append("item_amounts")
        if abs(gt - rgt) > TOLERANCE_CENTS:
            tags.append("grand_total")
        if ref is not None and ref.record.get("validation"):
            rv = ref.record["validation"]
            if v["ok"] and rv["ok"] and v["tax_scenario"] != rv["tax_scenario"]:
                tags.append("tax_scenario")
            elif not v["ok"] and abs(isum - risum) <= TOLERANCE_CENTS and abs(gt - rgt) <= TOLERANCE_CENTS:
                tags.append("charges_or_subtotal")
    if len(v["warnings"]) > (len(ref.record["validation"]["warnings"]) if ref and ref.record.get("validation")
                             else 0):
        tags.append("qty_unit_price")
    if not v["ok"] and not tags:
        tags.append("not_reconciled")
    return tags


def simulate_chain(primary: Outcome | None, fallback: Outcome | None, *, on_warnings: bool) -> Outcome | None:
    """Offline escalation from two independent runs (same calls the chain would make)."""
    if primary is None:
        return None
    escalate = (not primary.ok) or (on_warnings and bool(primary.record["validation"]["warnings"]))
    if not escalate or fallback is None:
        rec = dict(primary.record, escalated=False)
        return Outcome(rec)
    calls = primary.record["calls"] + fallback.record["calls"]
    # Same rule as extract_with_escalation: the last parsed extraction wins.
    final = fallback if fallback.extraction is not None else primary
    if on_warnings and primary.ok and not fallback.ok:
        final = primary  # don't trade a reconciled answer for an unreconciled one
    rec = dict(final.record, calls=calls, escalated=True,
               latency_ms=primary.record["latency_ms"] + fallback.record["latency_ms"],
               cost_micros=primary.record["cost_micros"] + fallback.record["cost_micros"])
    return Outcome(rec)


def load_runs(out: Path, cfg: Config, rid: str) -> list[Outcome]:
    run_dir = out / "runs" / cfg.id
    paths = [run_dir / f"{rid}.json", *sorted(run_dir.glob(f"{rid}~*.json"),
                                               key=lambda q: int(q.stem.rsplit("~", 1)[1]))]
    return [Outcome(rec) for rec in (read_json(q) for q in paths) if rec is not None]


def stage_report(configs: list[Config], out: Path, entries: list[dict[str, Any]], settings: Settings) -> None:
    texts_ids = sorted(p.stem for p in (out / "ocr").glob("*.md"))
    groups = read_json(out / "groups.json", {}) or {}
    receipt_ids = texts_ids + [f"group-{g}" for g in groups]
    adjudication = read_json(out / "adjudication.json", {}) or {}
    manifest = {e["sha"]: e for e in entries}
    ocr_meta = {sha: read_json(out / "ocr" / f"{sha}.json", {}) for sha in texts_ids}

    # results[spec][rid] = one Outcome per repeat
    results: dict[str, dict[str, list[Outcome]]] = defaultdict(dict)
    for cfg in configs:
        for rid in receipt_ids:
            runs = load_runs(out, cfg, rid)
            if runs:
                results[cfg.spec][rid] = runs

    # Offline chains from the independent runs (repeat r of the primary with repeat r of the
    # fallback): every cheaper -> dearer pair, plus the configured chain escalating on warnings too.
    base = [c for c in configs if not c.is_chain]
    by_spec = {c.spec: c for c in base}

    def unit_price(cfg: Config) -> float:
        price = resolve_price(cfg.steps[0][0], settings.llm_prices)
        return float(price.input + price.output) if price else float("inf")

    sims: list[tuple[str, Config, Config, bool]] = []
    for p in base:
        for f in base:
            if p.steps[0][0] != f.steps[0][0] and unit_price(p) < unit_price(f):
                sims.append((f"{p.spec}>{f.spec} [sim]", p, f, False))
    for chain in [c for c in configs if c.is_chain]:
        p_spec, f_spec = ("@".join(x for x in step if x) for step in chain.steps[:2])
        if p_spec in by_spec and f_spec in by_spec:
            sims.append((f"{chain.spec} +warnings [sim]", by_spec[p_spec], by_spec[f_spec], True))
    for name, p, f, warn in sims:
        for rid in receipt_ids:
            prim, fall = results[p.spec].get(rid, []), results[f.spec].get(rid, [])
            runs = [o for o in (simulate_chain(a, b, on_warnings=warn) for a, b in zip(prim, fall, strict=False))
                    if o is not None]
            if runs:
                results[name][rid] = runs

    # Consensus: one vote per independent run (all repeats of all non-chain configurations).
    consensus: dict[str, dict[str, Any]] = {}
    for rid in receipt_ids:
        outs = [(c.spec, o) for c in base for o in results[c.spec].get(rid, [])]
        need = len(outs) // 2 + 1
        cons: dict[str, Any] = {"voters": len(outs)}
        for idx, field_name in enumerate(("grand_total", "items", "items_sum")):
            top = Counter(o.key[idx] for _, o in outs if o.key is not None).most_common(1)
            cons[field_name] = top[0][0] if top and top[0][1] >= need else None
        top_t = Counter(o.key for _, o in outs if o.key is not None).most_common(1)
        cons["key"] = top_t[0][0] if top_t and top_t[0][1] >= need else None
        cons["key_votes"] = top_t[0][1] if top_t else 0
        adj = adjudication.get(rid)
        if adj and "grand_total" in adj:
            cons["truth"] = (round(adj["grand_total"] * 100), int(adj["items"]), round(adj["items_sum"] * 100))
        consensus[rid] = cons

    def reference(rid: str) -> tuple[tuple[int, int, int] | None, Outcome | None]:
        cons = consensus[rid]
        key = cons.get("truth") or cons["key"]
        ref = None
        if key is not None:
            ref = next((o for c in base for o in results[c.spec].get(rid, []) if o.key == key), None)
        return key, ref

    # ---- aggregate rows
    rows: list[dict[str, Any]] = []
    tag_counts: dict[str, Counter[str]] = {}
    for spec in [c.spec for c in configs] + [s[0] for s in sims]:
        samples = [(rid, o) for rid, runs in results.get(spec, {}).items() for o in runs]
        if not samples:
            continue
        lat = [o.record["latency_ms"] for _, o in samples]
        cost = [o.record["cost_micros"] for _, o in samples]
        tin = [sum(c["input_tokens"] for c in o.record["calls"]) for _, o in samples]
        tout = [sum(c["output_tokens"] for c in o.record["calls"]) for _, o in samples]
        status = Counter(o.status for _, o in samples)
        agree: Counter[str] = Counter()
        tags: Counter[str] = Counter()
        for rid, o in samples:
            cons = consensus[rid]
            for idx, f in enumerate(("grand_total", "items", "items_sum")):
                if cons[f] is not None:
                    agree[f + "_n"] += 1
                    agree[f] += int(o.key is not None and o.key[idx] == cons[f])
            key, ref = reference(rid)
            if key is not None:
                agree["correct_n"] += 1
                agree["correct"] += int(o.key == key and o.ok)
            manual = (adjudication.get(rid) or {}).get("failures", {})
            if spec in manual:
                rtags = list(manual[spec])
            elif o.ok and o.key == key:
                rtags = []
            else:
                rtags = auto_tags(o, key, ref)
            o.record["_tags"] = rtags
            tags.update(set(rtags))
        tag_counts[spec] = tags
        rows.append({
            "config": spec, "n": len(samples), "receipts": len(results[spec]), "succeeded": status["succeeded"],
            "needs_review": status["needs_review"], "error": status["error"],
            "escalated": sum(1 for _, o in samples if o.record.get("escalated")),
            "p50_ms": percentile(lat, 50), "p95_ms": percentile(lat, 95), "max_ms": max(lat),
            "in_tok": sum(tin) / len(tin), "out_tok": sum(tout) / len(tout),
            "usd_per_receipt": sum(cost) / len(cost) / 1e6, "usd_total": sum(cost) / 1e6,
            "agree_gt": (agree["grand_total"], agree["grand_total_n"]),
            "agree_items": (agree["items"], agree["items_n"]),
            "agree_isum": (agree["items_sum"], agree["items_sum_n"]),
            "correct": (agree["correct"], agree["correct_n"]),
        })

    ocr_lat = [m["latency_ms"] for m in ocr_meta.values() if m]
    ocr_pages = sum(int(r.get("pages", 0)) for r in read_jsonl(out / "azure_ledger.jsonl"))
    spent = sum(int(r.get("cost_micros", 0)) for r in read_jsonl(out / "openai_ledger.jsonl"))
    no_cons = [rid for rid in receipt_ids if consensus[rid]["key"] is None]
    sizes = [manifest[s]["bytes"] for s in texts_ids if s in manifest]

    # ---- aggregate markdown (no receipt content: counts, rates, timings, costs only)
    agg: list[str] = [
        f"Receipts: {len(texts_ids)} unique photos with OCR"
        + (f" + {len(groups)} multi-photo groups" if groups else "")
        + f"; Azure pages used {ocr_pages}; OpenAI spend ${spent / 1e6:.3f}."]
    if sizes:
        agg.append(f"Preprocessed JPEG size: p50 {percentile(sizes, 50) / 1024:.0f} KB, "
                   f"p95 {percentile(sizes, 95) / 1024:.0f} KB, max {max(sizes) / 1024:.0f} KB.")
    if ocr_lat:
        agg.append(f"OCR latency per page: p50 {secs(percentile(ocr_lat, 50))}, "
                   f"p95 {secs(percentile(ocr_lat, 95))}, max {secs(max(ocr_lat))}.")
    agg.append(f"Receipts without a majority on (grand total, item count, items sum): {len(no_cons)} "
               f"of {len(receipt_ids)}.")
    agg += ["", "| Configuration | runs | Reconciled | needs_review | error | escalated | p50 | p95 | max "
                "| in tok | out tok | $/receipt | $/1k receipts | = total | = item count | = items sum "
                "| correct & reconciled |",
            "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        agg.append(
            f"| {r['config']} | {r['n']} | {pct(r['succeeded'], r['n'])} | {r['needs_review']} | {r['error']} "
            f"| {r['escalated']} | {secs(r['p50_ms'])} | {secs(r['p95_ms'])} | {secs(r['max_ms'])} "
            f"| {r['in_tok']:.0f} | {r['out_tok']:.0f} | ${r['usd_per_receipt']:.5f} "
            f"| ${r['usd_per_receipt'] * 1000:.2f} | {pct(*r['agree_gt'])} | {pct(*r['agree_items'])} "
            f"| {pct(*r['agree_isum'])} | {pct(*r['correct'])} |")
    all_tags = sorted({t for c in tag_counts.values() for t in c})
    if all_tags:
        agg += ["", "Failure tags (runs carrying each tag; a run may carry several):", "",
                "| Configuration | " + " | ".join(all_tags) + " |", "|---|" + "---|" * len(all_tags)]
        for spec, counts in tag_counts.items():
            agg.append(f"| {spec} | " + " | ".join(str(counts.get(t, 0)) for t in all_tags) + " |")
    (out / "aggregate.md").write_text("\n".join(agg) + "\n", "utf-8")

    # ---- private per-receipt report
    rep: list[str] = ["# Receipt benchmark – PRIVATE (contains receipt data; never commit)", "",
                      f"Generated {now_iso()}.", "", *agg, "", "## Per receipt", "",
                      "Run = status grand/items/items-sum [tags] latency. ✓ reconciled, ✗ needs_review, ! error. "
                      "Reference = adjudicated truth if present, else the majority over all independent runs.", ""]
    for rid in receipt_ids:
        cons = consensus[rid]
        key, _ = reference(rid)
        m, om = manifest.get(rid, {}), ocr_meta.get(rid, {})
        head = f"### {rid[:12]}"
        if m:
            head += f" — {m.get('source')} ({m.get('bytes', 0) // 1024} KB, OCR {om.get('latency_ms', '–')} ms)"
        rep.append(head)
        ref_txt = "NO CONSENSUS" if key is None else f"{money(key[0])} / {key[1]} items / {money(key[2])}"
        src = "adjudicated" if cons.get("truth") else f"consensus {cons['key_votes']}/{cons['voters']}"
        rep.append(f"- reference ({src}): {ref_txt}")
        if (adjudication.get(rid) or {}).get("notes"):
            rep.append(f"- notes: {adjudication[rid]['notes']}")
        for spec in [c.spec for c in configs]:
            cells = []
            for o in results.get(spec, {}).get(rid, []):
                mark = {"succeeded": "✓", "needs_review": "✗", "error": "!"}[o.status]
                val = "–" if o.key is None else f"{money(o.key[0])}/{o.key[1]}/{money(o.key[2])}"
                tags = o.record.get("_tags") or []
                cells.append(f"{mark} {val}{' esc' if o.record.get('escalated') else ''}"
                             f"{(' [' + ', '.join(tags) + ']') if tags else ''} {o.record['latency_ms'] / 1000:.1f}s")
            if cells:
                rep.append(f"- {spec}: " + " · ".join(cells))
        rep.append("")
    (out / "report.md").write_text("\n".join(rep) + "\n", "utf-8")
    write_json(out / "results.json", {"generated": now_iso(), "rows": rows,
                                      "tags": {k: dict(v) for k, v in tag_counts.items()},
                                      "consensus": consensus, "no_consensus": no_cons,
                                      "ocr_latency_ms": ocr_lat, "azure_pages": ocr_pages, "openai_micros": spent})
    print("\n".join(agg))


# ----------------------------------------------------------------------------- main
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", type=Path, nargs="+", default=[BACKEND / "uploads"],
                    help="one or more directories of receipt photos (deduplicated by SHA-256)")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="private output directory (default .local/benchmark)")
    ap.add_argument("--stages", default="prep,ocr,llm,report", help="comma list of prep,ocr,llm,report")
    ap.add_argument("--configs", default=DEFAULT_CONFIGS, help="comma list of model@effort (or model)")
    ap.add_argument("--chain", default=DEFAULT_CHAIN, help="primary@effort>fallback@effort ('' to skip)")
    ap.add_argument("--only", default="", help="comma list of receipt id prefixes to run (default all)")
    ap.add_argument("--limit", type=int, default=0, help="run at most N receipts (0 = all)")
    ap.add_argument("--budget-usd", type=float, default=3.0, help="hard OpenAI cap across runs in --out")
    ap.add_argument("--max-pages", type=int, default=80, help="hard Azure page cap across runs in --out")
    ap.add_argument("--ocr-interval", type=float, default=4.0,
                    help="seconds between Azure submissions (at least 4; the request limiter applies too)")
    ap.add_argument("--concurrency", type=int, default=3, help="parallel LLM calls per configuration")
    ap.add_argument("--repeats", type=int, default=1,
                    help="runs per configuration × receipt (repeat r is only started after repeat r-1 everywhere)")
    ap.add_argument("--max-edge", type=int, default=2000)
    ap.add_argument("--jpeg-quality", type=int, default=80)
    args = ap.parse_args()

    if args.ocr_interval < 4:
        raise SystemExit("--ocr-interval must be at least 4 seconds (Azure F0)")
    out: Path = args.out.resolve()
    if args.out == DEFAULT_OUT and not str(out).startswith(str(REPO_ROOT / ".local")):
        raise SystemExit("refusing to write outside .local/")
    out.mkdir(parents=True, exist_ok=True)
    stages = {s.strip() for s in args.stages.split(",") if s.strip()}
    configs = [parse_config(s) for s in args.configs.split(",") if s.strip()]
    if args.chain.strip():
        configs.append(parse_config(args.chain))
    settings = get_settings()

    entries = stage_prep(args.input, out, args.max_edge, args.jpeg_quality) if "prep" in stages else load_manifest(out)
    if args.only:
        prefixes = tuple(p.strip() for p in args.only.split(",") if p.strip())
        entries = [e for e in entries if e["sha"].startswith(prefixes)]
    if args.limit:
        entries = entries[: args.limit]

    if "ocr" in stages:
        if not (settings.azure_di_endpoint and settings.azure_di_key):
            raise SystemExit("AZURE_DI_ENDPOINT / AZURE_DI_KEY are not set")
        asyncio.run(stage_ocr(entries, out, settings, args.max_pages, args.ocr_interval))
    if "llm" in stages:
        if not settings.openai_api_key:
            raise SystemExit("OPENAI_API_KEY is not set")
        texts = load_texts(entries, out)
        if args.only:
            texts = {k: v for k, v in texts.items() if k.startswith(prefixes) or k.startswith("group-")
                     and any(k[6:].startswith(p) for p in prefixes)}
        budget = Budget(out / "openai_ledger.jsonl", int(args.budget_usd * 1_000_000))
        asyncio.run(stage_llm(configs, texts, out, settings, budget, args.concurrency, args.repeats))
    if "report" in stages:
        stage_report(configs, out, load_manifest(out) if args.only or args.limit else entries, settings)


if __name__ == "__main__":
    main()
