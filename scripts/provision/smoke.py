#!/usr/bin/env python3
"""Production smoke test (stdlib only; also runs in GitHub Actions).

    python scripts/provision/smoke.py [--api URL] [--pages URL] [--skip-pages]
                                      [--maintenance-guard] [--maintenance-run]

Defaults come from API_BASE_URL / PAGES_URL (.env.production.local, .env or the environment).
Checks: backend warm-up (GET /api/health, 6 × 20 s for a cold start) · GET /api/health/ready (DB)
· CORS preflight from the Pages origin (exact Access-Control-Allow-Origin) and a foreign origin
(no ACAO) · Pages URL 200 · SPA deep link 200.
--maintenance-guard: POST /api/internal/maintenance WITHOUT the secret must be 401 (no side effects).
--maintenance-run:   the real call with Bearer CRON_SECRET (purges expired photos, touches the DB).
Prints status codes and non-secret bodies only. Exit 1 if any check fails.
"""

from __future__ import annotations

import argparse
import json
import time

from _common import Env, origin_of, raw_request

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str) -> bool:
    results.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {detail}")
    return ok


def short(body: str) -> str:
    try:
        return json.dumps(json.loads(body), separators=(",", ":"))[:200]
    except ValueError:
        return body.strip().replace("\n", " ")[:120]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--api", default="")
    ap.add_argument("--pages", default="")
    ap.add_argument("--skip-pages", action="store_true", help="backend checks only")
    ap.add_argument("--warm-retries", type=int, default=6)
    ap.add_argument("--warm-interval", type=int, default=20)
    ap.add_argument("--maintenance-guard", action="store_true")
    ap.add_argument("--maintenance-run", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="print what would be checked")
    args = ap.parse_args()
    env = Env()
    api = (args.api or env.prod_get("API_BASE_URL")).rstrip("/")
    pages = origin_of(args.pages or env.prod_get("PAGES_URL")) if (args.pages or env.prod_get("PAGES_URL")) else ""

    if args.dry_run or not api:
        print(f"[dry-run] API={api or '<API_BASE_URL unset>'} PAGES={pages or '<PAGES_URL unset>'}")
        print("[dry-run] would check: /api/health (warm-up), /api/health/ready, CORS preflight, "
              "Pages /, SPA deep link" + (", maintenance" if args.maintenance_guard or args.maintenance_run else ""))
        return 0 if args.dry_run else 1

    print(f"API {api}\nPages {pages or '(none)'}")
    # 1. warm-up: Render Free sleeps after ~15 min idle; the first request can take ~1 min.
    status, body = 0, ""
    for attempt in range(1, args.warm_retries + 1):
        status, _, body = raw_request("GET", f"{api}/api/health", timeout=60)
        if status == 200:
            break
        print(f"  warm-up {attempt}/{args.warm_retries}: HTTP {status}; retrying in {args.warm_interval}s")
        time.sleep(args.warm_interval)
    check("GET /api/health", status == 200, f"HTTP {status} {short(body)}")

    status, _, body = raw_request("GET", f"{api}/api/health/ready", timeout=60)
    check("GET /api/health/ready (database)", status == 200, f"HTTP {status} {short(body)}")

    if pages:
        pre = {"Origin": pages, "Access-Control-Request-Method": "GET",
               "Access-Control-Request-Headers": "authorization,content-type"}
        status, headers, _ = raw_request("OPTIONS", f"{api}/api/me", headers=pre)
        acao = headers.get("access-control-allow-origin", "")
        check("CORS preflight from Pages origin", status == 200 and acao == pages,
              f"HTTP {status}, Access-Control-Allow-Origin={acao or '(none)'}")
        status, headers, _ = raw_request("OPTIONS", f"{api}/api/me", headers={**pre, "Origin": "https://evil.example"})
        acao = headers.get("access-control-allow-origin", "")
        check("CORS rejects a foreign origin", acao not in ("*", "https://evil.example"),
              f"HTTP {status}, Access-Control-Allow-Origin={acao or '(none)'}")

    if pages and not args.skip_pages:
        status, headers, body = raw_request("GET", f"{pages}/")
        check("Pages /", status == 200 and "html" in headers.get("content-type", ""),
              f"HTTP {status} {headers.get('content-type', '')}")
        status, headers, body = raw_request("GET", f"{pages}/bills/smoke-deep-link")
        served = 'id="root"' in body
        check("SPA deep link /bills/smoke-deep-link", status == 200 and served,
              f"HTTP {status} (index.html served: {'yes' if served else 'no'})")

    if args.maintenance_guard:
        status, _, body = raw_request("POST", f"{api}/api/internal/maintenance")
        check("maintenance rejects calls without the secret", status == 401, f"HTTP {status} {short(body)}")
    if args.maintenance_run:
        secret = env.prod_get("CRON_SECRET")
        if not secret:
            check("maintenance run", False, "CRON_SECRET not set")
        else:
            status, _, body = raw_request("POST", f"{api}/api/internal/maintenance",
                                          headers={"Authorization": f"Bearer {secret}"}, timeout=120)
            check("maintenance run", status == 200, f"HTTP {status} {short(body)}")

    failed = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed" + (f"; FAILED: {', '.join(failed)}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
