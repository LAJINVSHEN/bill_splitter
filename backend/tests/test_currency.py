"""Multi-currency: minor units, currency table, conversion maths, saved FX rates, per-bill
conversion snapshots, the settlement lock, summary grouping and detected receipt currency."""

from __future__ import annotations

import json
import random
from decimal import Decimal
from pathlib import Path

import pytest

from app.core.currencies import currencies, exponent, normalize_code
from app.core.money import (
    allocate,
    convert_allocation,
    convert_minor,
    format_cents,
    parse_major,
    to_cents,
    tolerance_minor,
)
from app.core.receipt_validation import ReceiptItem, validate_receipt
from tests.conftest import AppUser, Ctx, jpeg, make_extraction
from tests.test_bills import full_bill

ROOT = Path(__file__).resolve().parents[2]
VECTORS = json.loads((ROOT / "shared" / "split-vectors.json").read_text("utf-8"))


# ------------------------------------------------------------------------- currency table
def test_shared_currency_table_matches_backend_copy() -> None:
    shared = json.loads((ROOT / "shared" / "currencies.json").read_text("utf-8"))
    bundled = json.loads((Path(__file__).resolve().parents[1] / "app" / "core" / "data" / "currencies.json")
                         .read_text("utf-8"))
    assert shared == bundled  # edit shared/currencies.json, then copy it to backend/app/core/data/


def test_exponents() -> None:
    for code in ("JPY", "KRW", "VND", "IDR", "CLP", "ISK", "XAF"):
        assert exponent(code) == 0, code
    for code in ("BHD", "KWD", "OMR", "JOD", "TND", "LYD", "IQD"):
        assert exponent(code) == 3, code
    for code in ("SGD", "MYR", "USD", "EUR", "GBP", "THB", "CNY"):
        assert exponent(code) == 2, code
    table = currencies()
    assert len(table) > 140 and all(c.symbol and c.name and len(c.code) == 3 for c in table.values())
    assert normalize_code(" myr ") == "MYR" and normalize_code("RM") is None and normalize_code(None) is None


@pytest.mark.parametrize(("amount", "exp", "minor"), [
    ("12.345", 2, 1235), ("1200", 0, 1200), ("1200.5", 0, 1201), ("1.2345", 3, 1235), (2.675, 2, 268),
    ("-0.0005", 3, -1),
])
def test_to_cents_by_exponent(amount: object, exp: int, minor: int) -> None:
    assert to_cents(amount, exp) == minor  # type: ignore[arg-type]


def test_format_and_strict_parse_by_exponent() -> None:
    assert format_cents(1234) == "12.34"
    assert format_cents(1234, 0) == "1234"
    assert format_cents(1234, 3) == "1.234"
    assert format_cents(-5, 3) == "-0.005"
    assert parse_major("1,234.50", 2) == 123450
    assert parse_major("980", 0) == 980
    assert parse_major("3.250", 3) == 3250
    with pytest.raises(ValueError):
        parse_major("12.345", 2)
    with pytest.raises(ValueError):
        parse_major("980.5", 0)


def test_tolerance_scales_with_exponent() -> None:
    assert [tolerance_minor(e) for e in (0, 2, 3)] == [1, 5, 50]


def test_validation_messages_use_the_currency_exponent() -> None:
    r = validate_receipt([ReceiptItem("Ramen", Decimal(1), 1000, 1000)], [], 1002, None, exponent=0)
    assert not r.ok and r.errors[0].technical == (
        "Items total (1000) does not match grand total (1002) and no taxes present. Difference: 2.")
    r = validate_receipt([ReceiptItem("Machboos", Decimal(1), 3500, 3500)], [], 3551, None, exponent=3)
    assert "Items total (3.500)" in r.errors[0].technical and "Difference: 0.051." in r.errors[0].technical


# ------------------------------------------------------------------------- conversion maths
def test_convert_minor_worked_examples() -> None:
    assert convert_minor(10000, Decimal("0.2950"), 2, 2) == 2950        # MYR 100.00 → S$29.50
    assert convert_minor(12000, Decimal("0.0091"), 0, 2) == 10920       # ¥12,000 → S$109.20
    assert convert_minor(4668, Decimal("110.25"), 2, 0) == 5146         # S$46.68 → ¥5,146.47 → ¥5,146
    assert convert_minor(3988, Decimal("4.4321"), 3, 2) == 1768         # 3.988 KWD → S$17.6752 → 17.68
    assert convert_minor(1, Decimal("0.5"), 2, 2) == 1                  # half a cent rounds up


def test_converted_shares_always_sum_exactly() -> None:
    rng = random.Random(11)
    codes = ["SGD", "JPY", "KWD", "MYR", "IDR"]
    for _ in range(1000):
        frm, to = rng.sample(codes, 2)
        shares = [rng.randint(0, 50_000) for _ in range(rng.randint(1, 8))]
        grand = sum(shares)
        rate = Decimal(rng.randint(1, 10**9)) / Decimal(10 ** rng.randint(0, 9))
        total, conv = convert_allocation(grand, shares, rate, exponent(frm), exponent(to))
        assert sum(conv) == total
        assert conv == allocate(total, shares)


@pytest.mark.parametrize("case", VECTORS["conversion_cases"], ids=lambda c: c["id"])
def test_golden_conversion_vector(case: dict) -> None:
    i, e = case["input"], case["expected"]
    total, conv = convert_allocation(i["grand_total_cents"], i["totals_cents"], Decimal(i["fx_rate"]),
                                     exponent(i["currency"]), exponent(i["settle_currency"]))
    assert (total, conv) == (e["settle_grand_total_cents"], e["settle_totals_cents"])


@pytest.mark.parametrize("case", VECTORS["minor_unit_cases"], ids=lambda c: f"{c['amount']}-{c['currency']}")
def test_golden_minor_unit_vector(case: dict) -> None:
    assert exponent(case["currency"]) == case["exponent"]
    assert to_cents(case["amount"], case["exponent"]) == case["expected_cents"]


def test_golden_tolerance_vectors() -> None:
    for case in VECTORS["tolerance_cases"]:
        assert tolerance_minor(exponent(case["currency"])) == case["expected_tolerance_cents"]


def test_vectors_cover_jpy_and_kwd() -> None:
    split_currencies = {c["input"].get("currency", "SGD") for c in VECTORS["split_cases"]}
    validation_currencies = {c["input"].get("currency", "SGD") for c in VECTORS["validation_cases"]}
    assert {"JPY", "KWD"} <= split_currencies and {"JPY", "KWD"} <= validation_currencies


# ------------------------------------------------------------------------- API: currencies on bills
async def test_unknown_currency_is_rejected(ctx: Ctx) -> None:
    user = await ctx.user()
    assert (await ctx.client.post("/api/bills", headers=user.headers, json={"currency": "XYZ"})).status_code == 422
    assert (await ctx.client.patch("/api/me", headers=user.headers, json={"default_currency": "ABC"})).status_code == 422
    r = await ctx.client.post("/api/bills", headers=user.headers, json={"currency": "jpy"})
    assert r.status_code == 201 and r.json()["currency"] == "JPY" and r.json()["effective_currency"] == "JPY"


async def test_jpy_bill_validation_uses_one_yen_tolerance(ctx: Ctx) -> None:
    user = await ctx.user()
    bill = (await ctx.client.post("/api/bills", headers=user.headers, json={"currency": "JPY"})).json()
    url = f"/api/bills/{bill['id']}/receipt"
    body = {"items": [{"name": "Ramen", "unit_price_cents": 1000, "total_price_cents": 1000}], "grand_total_cents": 1001}
    assert (await ctx.client.put(url, headers=user.headers, json=body)).json()["validation"]["ok"] is True
    r = await ctx.client.put(url, headers=user.headers, json={**body, "grand_total_cents": 1002})
    v = r.json()["validation"]
    assert not v["ok"] and "Items total (1000)" in v["errors"][0]["technical"]


# ------------------------------------------------------------------------- saved rates
async def test_fx_rates_crud_and_derived_inverse(ctx: Ctx) -> None:
    user = await ctx.user()
    h = user.headers
    r = await ctx.client.put("/api/me/fx-rates/myr/SGD", headers=h, json={"rate": "0.2950"})
    assert r.status_code == 200 and r.json()["rate"] == "0.295" and r.json()["derived"] is False
    inv = (await ctx.client.get("/api/me/fx-rates/SGD/MYR", headers=h)).json()
    assert inv["derived"] is True and inv["rate"] == "3.38983050847"
    # Saving the opposite direction replaces the pair (one row per pair).
    await ctx.client.put("/api/me/fx-rates/SGD/MYR", headers=h, json={"rate": 3.4})
    rates = (await ctx.client.get("/api/me/fx-rates", headers=h)).json()["items"]
    assert [(x["base"], x["quote"], x["rate"]) for x in rates] == [("SGD", "MYR", "3.4")]
    precise = await ctx.client.put("/api/me/fx-rates/JPY/SGD", headers=h, json={"rate": "0.009123456789"})
    assert precise.json()["rate"] == "0.009123456789"  # ≥ 10 significant digits survive the round trip
    assert (await ctx.client.delete("/api/me/fx-rates/MYR/SGD", headers=h)).status_code == 204  # either direction
    assert (await ctx.client.get("/api/me/fx-rates/SGD/MYR", headers=h)).status_code == 404
    assert (await ctx.client.delete("/api/me/fx-rates/MYR/SGD", headers=h)).status_code == 404
    bad = [("SGD", "SGD", "1"), ("SGD", "MYR", "0"), ("SGD", "MYR", "-1"), ("SGD", "MYR", "1.2345678901234567")]
    for base, quote, rate in bad:
        r = await ctx.client.put(f"/api/me/fx-rates/{base}/{quote}", headers=h, json={"rate": rate})
        assert r.status_code in (400, 422), (base, quote, rate)
    r = await ctx.client.put("/api/me/fx-rates/RMX/SGD", headers=h, json={"rate": "1"})
    assert r.status_code == 400 and r.json()["code"] == "unknown_currency"
    other = await ctx.user("mallory")
    assert (await ctx.client.get("/api/me/fx-rates", headers=other.headers)).json()["items"] == []
    assert (await ctx.client.get("/api/me/fx-rates/JPY/SGD", headers=other.headers)).status_code == 404


# ------------------------------------------------------------------------- per-bill conversion
async def _myr_bill(ctx: Ctx, user: AppUser) -> tuple[dict, dict[str, str]]:
    bill, ids = await full_bill(ctx, user)
    r = await ctx.client.patch(f"/api/bills/{bill['id']}", headers=user.headers, json={"currency": "MYR"})
    assert r.status_code == 200, r.text
    return r.json(), ids


async def test_conversion_snapshot_from_saved_rate_is_immutable(ctx: Ctx) -> None:
    user = await ctx.user()
    bill, ids = await _myr_bill(ctx, user)
    url = f"/api/bills/{bill['id']}"
    r = await ctx.client.patch(url, headers=user.headers, json={"settle_currency": "SGD"})
    assert r.status_code == 400 and r.json()["code"] == "fx_rate_required"
    await ctx.client.put("/api/me/fx-rates/MYR/SGD", headers=user.headers, json={"rate": "0.2950"})
    out = (await ctx.client.patch(url, headers=user.headers, json={"settle_currency": "SGD"})).json()
    assert out["settle_currency"] == "SGD" and out["fx_rate"] == "0.295" and out["effective_currency"] == "SGD"
    split = out["split"]
    assert split["currency"] == "MYR" and split["effective_currency"] == "SGD"
    assert split["settle_grand_total_cents"] == 1377  # MYR 46.68 × 0.295 = 13.7706 → S$13.77
    people = {p["person_id"]: p for p in split["people"]}
    assert sum(p["settle_total_cents"] for p in split["people"]) == 1377
    assert [people[ids[n]]["total_cents"] for n in "ABCD"] == [1276, 1276, 1426, 690]  # MYR, unchanged
    assert people[ids["B"]]["outstanding_cents"] == people[ids["B"]]["settle_total_cents"]
    # Editing the saved rate later never changes the bill.
    await ctx.client.put("/api/me/fx-rates/MYR/SGD", headers=user.headers, json={"rate": "0.31"})
    again = (await ctx.client.get(url, headers=user.headers)).json()
    assert again["fx_rate"] == "0.295" and again["split"]["settle_grand_total_cents"] == 1377
    # A typed rate overrides the snapshot and can be saved for next time.
    r = await ctx.client.patch(url, headers=user.headers, json={"fx_rate": "0.30", "save_rate": True})
    assert r.json()["fx_rate"] == "0.3" and r.json()["split"]["settle_grand_total_cents"] == 1400
    saved = (await ctx.client.get("/api/me/fx-rates/MYR/SGD", headers=user.headers)).json()
    assert saved["rate"] == "0.3"
    r = await ctx.client.patch(url, headers=user.headers, json={"settle_currency": "MYR", "fx_rate": "1"})
    assert r.status_code == 400 and r.json()["code"] == "settle_same_currency"
    cleared = (await ctx.client.patch(url, headers=user.headers, json={"settle_currency": None})).json()
    assert cleared["settle_currency"] is None and cleared["fx_rate"] is None
    assert cleared["split"]["settle_grand_total_cents"] is None and cleared["effective_currency"] == "MYR"


async def test_settlement_locks_currency_and_uses_effective_currency(ctx: Ctx) -> None:
    user = await ctx.user()
    bill, ids = await _myr_bill(ctx, user)
    url = f"/api/bills/{bill['id']}"
    await ctx.client.patch(url, headers=user.headers, json={"settle_currency": "SGD", "fx_rate": "0.2950"})
    r = await ctx.client.post(f"{url}/participants/{ids['B']}/settlement", headers=user.headers)
    b = next(p for p in r.json()["split"]["people"] if p["person_id"] == ids["B"])
    assert b["settled_amount_cents"] == b["settle_total_cents"] and b["outstanding_cents"] == 0
    assert r.json()["currency_locked"] is True
    for body in ({"currency": "SGD"}, {"settle_currency": None}, {"fx_rate": "0.31"}, {"settle_currency": "USD",
                                                                                         "fx_rate": "0.2"}):
        r = await ctx.client.patch(url, headers=user.headers, json=body)
        assert r.status_code == 409 and r.json()["code"] == "currency_locked", body
    # Other fields still editable; unsettling unlocks.
    assert (await ctx.client.patch(url, headers=user.headers, json={"title": "ok"})).status_code == 200
    await ctx.client.delete(f"{url}/participants/{ids['B']}/settlement", headers=user.headers)
    r = await ctx.client.patch(url, headers=user.headers, json={"fx_rate": "0.31"})
    assert r.status_code == 200 and r.json()["currency_locked"] is False


async def test_currency_change_rescales_minor_units_and_clears_conversion(ctx: Ctx) -> None:
    user = await ctx.user()
    bill, ids = await full_bill(ctx, user)  # SGD 46.68
    url = f"/api/bills/{bill['id']}"
    await ctx.client.patch(url, headers=user.headers, json={"settle_currency": "MYR", "fx_rate": "3.4"})
    jpy = (await ctx.client.patch(url, headers=user.headers, json={"currency": "JPY"})).json()
    # Same major-unit numbers, relabelled: S$17.00 → ¥17, 46.68 → ¥47 (half-up), discount -2.00 → -2.
    assert jpy["currency"] == "JPY" and jpy["settle_currency"] is None
    assert [i["total_price_cents"] for i in jpy["items"]] == [17, 10, 8, 6]
    assert jpy["grand_total_cents"] == 47 and jpy["subtotal_cents"] == 41
    assert [c["amount_cents"] for c in jpy["charges"]] == [4, 4, -2]
    kwd = (await ctx.client.patch(url, headers=user.headers, json={"currency": "KWD"})).json()
    assert [i["total_price_cents"] for i in kwd["items"]] == [17000, 10000, 8000, 6000]
    assert kwd["grand_total_cents"] == 47000
    assert kwd["split"]["grand_total_cents"] == 47000 and sum(p["total_cents"] for p in kwd["split"]["people"]) == 47000


async def test_public_share_shows_both_currencies(ctx: Ctx) -> None:
    user = await ctx.user()
    bill, ids = await _myr_bill(ctx, user)
    await ctx.client.patch(f"/api/bills/{bill['id']}", headers=user.headers,
                           json={"settle_currency": "SGD", "fx_rate": "0.2950"})
    link = (await ctx.client.post(f"/api/bills/{bill['id']}/share-links", headers=user.headers,
                                  json={"person_id": ids["C"]})).json()
    pub = (await ctx.client.get(f"/api/public/share/{link['token']}")).json()
    assert pub["currency"] == "MYR" and pub["settle_currency"] == "SGD" and pub["effective_currency"] == "SGD"
    assert pub["fx_rate"] == "0.295" and pub["settle_grand_total_cents"] == 1377
    assert pub["person"]["total_cents"] == 1426 and pub["person"]["settle_total_cents"] == 421
    assert pub["person"]["outstanding_cents"] == 421


async def test_summary_groups_by_effective_currency_with_home_block(ctx: Ctx) -> None:
    user = await ctx.user()  # default currency SGD
    sgd_bill, ids = await full_bill(ctx, user)
    myr_bill, _ = await full_bill(ctx, user)
    jpy_bill, _ = await full_bill(ctx, user)
    await ctx.client.patch(f"/api/bills/{myr_bill['id']}", headers=user.headers,
                           json={"currency": "MYR", "settle_currency": "SGD", "fx_rate": "0.2950"})
    await ctx.client.patch(f"/api/bills/{jpy_bill['id']}", headers=user.headers, json={"currency": "JPY"})
    for b in (sgd_bill, myr_bill, jpy_bill):
        await ctx.client.patch(f"/api/bills/{b['id']}", headers=user.headers, json={"status": "complete"})
    s = (await ctx.client.get("/api/me/summary", headers=user.headers)).json()
    sgd_owed = 1276 + 1426 + 690
    myr_owed_in_sgd = 1377 - (await ctx.client.get(f"/api/bills/{myr_bill['id']}/split", headers=user.headers)
                              ).json()["people"][0]["settle_total_cents"]
    assert s["home"] == {"currency": "SGD", "owed_to_me_cents": sgd_owed + myr_owed_in_sgd, "i_owe_cents": 0}
    assert {c["currency"] for c in s["currencies"]} == {"SGD", "JPY"}  # MYR bill counts as SGD (converted)
    jpy = next(c for c in s["currencies"] if c["currency"] == "JPY")
    assert jpy["owed_to_me_cents"] == 14 + 15 + 7  # never folded into the home total
    assert {b["currency"] for b in s["bills"]} == {"SGD", "JPY"}


# ------------------------------------------------------------------------- extraction
async def _scan(ctx: Ctx, user: AppUser, bill_id: str) -> dict:
    r = await ctx.client.post(f"/api/bills/{bill_id}/scans", headers=user.headers,
                              files=[("files", ("r.jpg", jpeg(), "image/jpeg"))])
    assert r.status_code == 202, r.text
    await ctx.drain()
    return (await ctx.client.get(f"/api/jobs/{r.json()['job_id']}", headers=user.headers)).json()


async def test_detected_currency_is_reported_not_applied(ctx: Ctx) -> None:
    user = await ctx.user()
    myr = make_extraction([("Nasi Lemak", 2, 8.5, 17.0)], [("SST 6%", 1.02)], subtotal=17.0, grand=18.02)
    myr.currency = "MYR"
    ctx.llm.default = myr
    bill_id = (await ctx.client.post("/api/bills", headers=user.headers, json={})).json()["id"]
    job = await _scan(ctx, user, bill_id)
    assert job["status"] == "succeeded" and job["detected_currency"] == "MYR"
    bill = (await ctx.client.get(f"/api/bills/{bill_id}", headers=user.headers)).json()
    assert bill["currency"] == "SGD" and bill["latest_job"]["detected_currency"] == "MYR"
    for printed in ("SGD", "RM", None):  # same as the bill, not a code, or not found → nothing to offer
        myr.currency = printed
        other = (await ctx.client.post("/api/bills", headers=user.headers, json={})).json()["id"]
        assert (await _scan(ctx, user, other))["detected_currency"] is None, printed


async def test_extracted_amounts_use_the_bill_currency_exponent(ctx: Ctx) -> None:
    user = await ctx.user()
    ctx.llm.default = make_extraction([("Ramen", 2, 980.0, 1960.0), ("Gyoza", 1, 480.0, 480.0)],
                                      [("Tax 10%", 244.0)], subtotal=2440.0, grand=2684.0)
    jpy = (await ctx.client.post("/api/bills", headers=user.headers, json={"currency": "JPY"})).json()["id"]
    job = await _scan(ctx, user, jpy)
    assert job["status"] == "succeeded" and job["validation"]["ok"]
    bill = (await ctx.client.get(f"/api/bills/{jpy}", headers=user.headers)).json()
    assert [i["total_price_cents"] for i in bill["items"]] == [1960, 480] and bill["grand_total_cents"] == 2684
    ctx.llm.default = make_extraction([("Machboos", 1, 3.5, 3.5)], [], grand=3.55)  # 50 fils off: within tolerance
    kwd = (await ctx.client.post("/api/bills", headers=user.headers, json={"currency": "KWD"})).json()["id"]
    job = await _scan(ctx, user, kwd)
    assert job["status"] == "succeeded"
    bill = (await ctx.client.get(f"/api/bills/{kwd}", headers=user.headers)).json()
    assert bill["items"][0]["total_price_cents"] == 3500 and bill["grand_total_cents"] == 3550
