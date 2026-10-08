#!/usr/bin/env python3
"""Render: create/find the free Docker web service `even-api` (Singapore) and sync its env vars;
or trigger a deploy and wait until it is live.

    python scripts/provision/render.py [--dry-run] [--owner <name|id>] [--deploy]
    python scripts/provision/render.py deploy [--commit <sha>] [--wait] [--timeout 1200]

Needs RENDER_API_KEY in .env; and the Render GitHub App must have access to LAJINVSHEN/bill_splitter.
Provisioning is idempotent: the service is found by name; settings are PATCHed only on drift;
env vars are upserted one key at a time (PUT /services/{id}/env-vars/{key}); nothing is deleted.
If Render refuses the free-plan create, the exact dashboard steps are printed instead; create the
service by hand, then re-run this script to set everything else.

`deploy` is what .github/workflows/deploy-backend-render.yml runs. It uses RENDER_API_KEY +
RENDER_SERVICE_ID (POST /services/{id}/deploys, then GET .../deploys/{deployId} until `live`), or
falls back to RENDER_DEPLOY_HOOK_URL (?ref=<sha>) and then waits for API_BASE_URL/api/health.

API: https://api.render.com/v1 (OpenAPI https://api-docs.render.com/openapi/render-public-api-1.json,
checked 2026-10-07): GET /owners, GET|POST /services, GET|PATCH /services/{id},
DELETE /services/{id}/autoscaling, POST /services/{id}/scale, GET /services/{id}/env-vars,
PUT /services/{id}/env-vars/{key}, POST|GET /services/{id}/deploys[/{deployId}].
"""

from __future__ import annotations

import argparse
import time

from _common import (GITHUB_REPO, RENDER_SERVICE_NAME, Env, HttpError, die, http, pages_url, poll,
                     random_secret, raw_request, require, step)

API = "https://api.render.com/v1"
DOCKERFILE = "backend/Dockerfile.render"   # forward slashes: Render rejects backslashes
DOCKER_CONTEXT = "backend"
HEALTH_PATH = "/api/health"                # liveness only (no DB), so a DB blip never restarts the instance
FAILED = {"build_failed", "update_failed", "canceled", "pre_deploy_failed", "deactivated"}

FORCED = {
    "ENVIRONMENT": "production",
    "SUPABASE_ADMIN_BACKEND": "supabase",
    "STORAGE_BACKEND": "supabase",
    "OCR_BACKEND": "azure",
    "LLM_BACKEND": "openai",
    "RATE_LIMIT_ENABLED": "true",
}
FROM_PROD_FILE = ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_JWT_SECRET",
                  "AUTH_EMAIL_DOMAIN", "STORAGE_BUCKET"]
APP_KEYS = ["OPENAI_API_KEY", "AZURE_DI_ENDPOINT", "AZURE_DI_KEY"]   # .env.production.local, else .env
TUNING = ["APP_NAME", "LOG_LEVEL", "APP_TIMEZONE", "DEFAULT_CURRENCY", "DB_POOL_SIZE", "DB_MAX_OVERFLOW",
          "JWT_AUDIENCE", "JWT_LEEWAY_SECONDS", "JWKS_CACHE_SECONDS", "OCR_MAX_CONCURRENCY",
          "OCR_MAX_PDF_PAGES", "OCR_TIMEOUT_SECONDS", "LLM_PRIMARY_MODEL", "LLM_PRIMARY_REASONING_EFFORT",
          "LLM_FALLBACK_MODEL", "LLM_FALLBACK_REASONING_EFFORT", "LLM_TIMEOUT_SECONDS", "LLM_MAX_RETRIES",
          "LLM_MAX_OUTPUT_TOKENS", "LLM_PRICES", "SIGNED_URL_TTL_SECONDS", "RECEIPT_RETENTION_DAYS",
          "SCAN_MAX_FILES", "SCAN_MAX_FILE_BYTES", "JOB_HEARTBEAT_SECONDS", "JOB_STALE_SECONDS",
          "DEFAULT_USER_MONTHLY_QUOTA", "GLOBAL_MONTHLY_PAGE_CAP", "GLOBAL_MONTHLY_LLM_BUDGET_USD",
          "RATE_LIMIT_DEFAULT", "RATE_LIMIT_SCANS", "RATE_LIMIT_PUBLIC", "RATE_LIMIT_ADMIN_CREATE",
          "MAX_JSON_BODY_BYTES"]
NEVER = {"DEV_LOGIN_PASSWORD", "LOCAL_STORAGE_DIR"}  # dev-only; flagged if found on the service

DASHBOARD_STEPS = f"""
  Create it in the dashboard instead (about 2 minutes):
    1. https://dashboard.render.com → New → Web Service → Git provider → {GITHUB_REPO}
    2. Name: {RENDER_SERVICE_NAME} · Region: Singapore · Branch: main · Language: Docker
    3. Root Directory: (empty) · Dockerfile Path: {DOCKERFILE} · Docker Build Context Directory: {DOCKER_CONTEXT}
    4. Instance Type: Free · Advanced → Health Check Path: {HEALTH_PATH} · Auto-Deploy: Off
    5. Skip env vars and click Deploy (the first deploy may fail without them; that's fine)
    6. Re-run: python scripts/provision/render.py   (finds the service by name, sets env vars, fixes drift)
"""


class Api:
    def __init__(self, key: str, dry_run: bool) -> None:
        self.key, self.dry_run = key, dry_run

    def get(self, path: str):
        return http("GET", f"{API}{path}", token=self.key)[1]

    def write(self, method: str, path: str, body=None, label: str = ""):
        if self.dry_run:
            print(f"  [dry-run] would {method} {path} {label}".rstrip())
            return None
        return http(method, f"{API}{path}", token=self.key, body=body)[1]


def desired_env(env: Env, site: str, cron_secret: str) -> tuple[dict[str, str], list[str]]:
    values = dict(FORCED)
    missing = []
    for k in FROM_PROD_FILE:
        v = env.prod_get(k)
        if v:
            values[k] = v
        elif k != "SUPABASE_JWT_SECRET":  # optional: JWKS covers asymmetric signing keys
            missing.append(k)
    for k in APP_KEYS:
        v = env.get(k)
        if v:
            values[k] = v
        else:
            missing.append(k)
    for k in TUNING:
        v = env.get(k)
        if v:
            values[k] = v
    values["PUBLIC_APP_URL"] = site
    values["CORS_ORIGINS"] = site
    values["CRON_SECRET"] = cron_secret
    return values, missing


def pick_owner(api: Api, wanted: str) -> dict:
    owners = [o["owner"] for o in api.get("/owners?limit=100")]
    if wanted:
        for o in owners:
            if wanted in (o["id"], o["name"], o.get("email")):
                return o
        die(f"workspace {wanted!r} not found: {', '.join(o['name'] for o in owners)}")
    if len(owners) == 1:
        return owners[0]
    die("several workspaces; pass --owner <name>: " + ", ".join(o["name"] for o in owners))
    return {}


def find_service(api: Api, owner_id: str, name: str) -> dict | None:
    items = api.get(f"/services?name={name}&type=web_service&ownerId={owner_id}&limit=20")
    for item in items:
        if item["service"]["name"] == name:
            return item["service"]
    return None


def create_service(api: Api, owner_id: str, name: str, env_vars: dict[str, str]) -> dict | None:
    body = {
        "type": "web_service",
        "name": name,
        "ownerId": owner_id,
        "repo": f"https://github.com/{GITHUB_REPO}",
        "branch": "main",
        "autoDeploy": "no",
        "autoDeployTrigger": "off",  # GitHub Actions is the only deploy path (tests + kill switch)
        "envVars": [{"key": k, "value": v} for k, v in env_vars.items()],
        "serviceDetails": {
            "runtime": "docker",
            "plan": "free",
            "region": "singapore",
            "numInstances": 1,
            "healthCheckPath": HEALTH_PATH,
            "pullRequestPreviewsEnabled": "no",
            "previews": {"generation": "off"},
            "envSpecificDetails": {"dockerContext": DOCKER_CONTEXT, "dockerfilePath": DOCKERFILE},
        },
    }
    if api.dry_run:
        print(f"  [dry-run] would POST /services (web_service '{name}', docker, free, singapore, "
              f"{DOCKERFILE}, health {HEALTH_PATH}, auto-deploy off, {len(env_vars)} env vars)")
        return None
    try:
        return http("POST", f"{API}/services", token=api.key, body=body)[1]["service"]
    except HttpError as exc:
        print(f"  Render refused the create: {exc}")
        if "repo" in exc.message.lower() or "github" in exc.message.lower():
            print("  Check: Render dashboard → Account → GitHub → the Render app can access the repo.")
        print(DASHBOARD_STEPS)
        raise SystemExit(2) from None


def fix_drift(api: Api, svc: dict) -> None:
    sd = svc.get("serviceDetails") or {}
    sid = svc["id"]
    if sd.get("region") != "singapore":
        print(f"  WARNING: region is {sd.get('region')} (can't be changed; recreate in Singapore for low latency)")
    if sd.get("disk"):
        print("  WARNING: a persistent disk is attached. Disks are paid; remove it in the dashboard.")
    patch: dict = {}
    details: dict = {}
    if svc.get("autoDeployTrigger", "off") != "off" or svc.get("autoDeploy") == "yes":
        patch.update({"autoDeploy": "no", "autoDeployTrigger": "off"})
    if sd.get("plan") != "free":
        details["plan"] = "free"
    if sd.get("healthCheckPath") != HEALTH_PATH:
        details["healthCheckPath"] = HEALTH_PATH
    esd = sd.get("envSpecificDetails") or {}
    if esd.get("dockerfilePath", "").lstrip("./") != DOCKERFILE or esd.get("dockerContext", "").lstrip("./") != DOCKER_CONTEXT:
        details["envSpecificDetails"] = {"dockerContext": DOCKER_CONTEXT, "dockerfilePath": DOCKERFILE}
    if sd.get("pullRequestPreviewsEnabled") == "yes":
        details["pullRequestPreviewsEnabled"] = "no"
    if details:
        patch["serviceDetails"] = details
    if patch:
        api.write("PATCH", f"/services/{sid}", patch, f"({', '.join(list(patch) + list(details))})")
        print(f"  fixed drift: {', '.join(k for k in list(patch) + list(details) if k != 'serviceDetails')}")
    else:
        print("  settings OK (free, singapore, docker, auto-deploy off)")
    if (sd.get("autoscaling") or {}).get("enabled"):
        api.write("DELETE", f"/services/{sid}/autoscaling")
        print("  autoscaling removed")
    if (sd.get("numInstances") or 1) > 1:
        api.write("POST", f"/services/{sid}/scale", {"numInstances": 1})
        print("  scaled to 1 instance (in-process scan jobs need exactly one)")


def sync_env(api: Api, sid: str, values: dict[str, str]) -> int:
    current: dict[str, str] = {}
    cursor = ""
    while True:
        page = api.get(f"/services/{sid}/env-vars?limit=100" + (f"&cursor={cursor}" if cursor else ""))
        for item in page:
            current[item["envVar"]["key"]] = item["envVar"]["value"]
        if len(page) < 100:
            break
        cursor = page[-1]["cursor"]
    changed = 0
    for key in sorted(values):
        if current.get(key) == values[key]:
            continue
        api.write("PUT", f"/services/{sid}/env-vars/{key}", {"value": values[key]})
        print(f"  {key}: {'updated' if key in current else 'added'}")
        changed += 1
    print(f"  {changed} env var(s) changed, {len(values) - changed} unchanged")
    extra = sorted(set(current) - set(values))
    if extra:
        print(f"  left as-is (not managed here): {', '.join(extra)}")
    for bad in NEVER & set(current):
        print(f"  WARNING: {bad} is set on the service; it is dev-only. Delete it in the dashboard.")
    return changed


# ----------------------------------------------------------------------------- deploy
def trigger_and_wait(env: Env, commit: str, wait: bool, timeout: int) -> int:
    key, sid, hook = env.get("RENDER_API_KEY"), env.get("RENDER_SERVICE_ID"), env.get("RENDER_DEPLOY_HOOK_URL")
    deploy_id = ""
    if key and sid:
        body = {"clearCache": "do_not_clear", **({"commitId": commit} if commit else {})}
        status, resp = http("POST", f"{API}/services/{sid}/deploys", token=key, body=body)
        deploy_id = (resp or {}).get("id", "")
        if not deploy_id:  # 202 Queued has no body: take the newest deploy
            time.sleep(5)
            items = http("GET", f"{API}/services/{sid}/deploys?limit=1", token=key)[1]
            deploy_id = items[0]["deploy"]["id"] if items else ""
        print(f"Deploy triggered via API (HTTP {status}) id={deploy_id or '?'} commit={commit[:12] or 'branch head'}")
    elif hook:
        url = hook + (("&" if "?" in hook else "?") + f"ref={commit}" if commit else "")
        status, resp = http("POST", url)
        resp = resp or {}
        deploy_id = (resp.get("deploy") or {}).get("id") or resp.get("id", "")
        print(f"Deploy triggered via deploy hook (HTTP {status}) id={deploy_id or '?'}")
    else:
        die("set RENDER_API_KEY + RENDER_SERVICE_ID (or RENDER_DEPLOY_HOOK_URL)")
    if not wait:
        return 0

    if key and sid and deploy_id:
        last = {"status": ""}

        def live():
            d = http("GET", f"{API}/services/{sid}/deploys/{deploy_id}", token=key)[1]
            if d.get("status") != last["status"]:
                last["status"] = d.get("status")
                print(f"  deploy status: {last['status']}")
            if d.get("status") in FAILED:
                die(f"deploy ended as {d.get('status')}. See the Render dashboard → Events/Logs.")
            return d.get("status") == "live"

        poll(live, timeout=timeout, interval=15, what="the deploy to go live")
        print("Deploy is live.")
        return 0

    api_url = env.get("API_BASE_URL")
    if not api_url:
        print("Can't confirm the deploy (no API key and no API_BASE_URL); check the Render dashboard.")
        return 0
    print("No API key to read deploy status; waiting for /api/health instead (best effort).")
    time.sleep(90)
    poll(lambda: raw_request("GET", f"{api_url.rstrip('/')}/api/health", timeout=60)[0] == 200,
         timeout=timeout, interval=20, what="/api/health")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", nargs="?", default="provision", choices=["provision", "deploy"])
    ap.add_argument("--dry-run", action="store_true", help="show the plan; no write calls")
    ap.add_argument("--owner", default="", help="workspace name or id (needed if you have several)")
    ap.add_argument("--name", default=RENDER_SERVICE_NAME)
    ap.add_argument("--deploy", action="store_true", help="after provisioning, deploy and wait until live")
    ap.add_argument("--commit", default="", help="deploy: commit SHA on main (default: branch head)")
    ap.add_argument("--wait", action="store_true", help="deploy: wait until live")
    ap.add_argument("--timeout", type=int, default=1200)
    args = ap.parse_args()
    env = Env()

    if args.command == "deploy":
        if args.dry_run:
            print("[dry-run] would trigger a deploy (API or deploy hook) and poll until live")
            return 0
        return trigger_and_wait(env, args.commit, args.wait, args.timeout)

    step(f"Render web service '{args.name}'")
    site = pages_url(env)
    cron_secret = env.prod_get("CRON_SECRET") or random_secret(48)
    values, missing = desired_env(env, site, cron_secret)
    if missing:
        print(f"  not set yet: {', '.join(missing)} (the service starts anyway; scans need AZURE_DI_*/OPENAI_API_KEY)")
    if not require(env, "RENDER_API_KEY", dry_run=args.dry_run):
        print(f"  [dry-run] would create/find '{args.name}' and set {len(values)} env vars: {', '.join(sorted(values))}")
        print(DASHBOARD_STEPS.replace("Create it in the dashboard instead", "Fallback if the API refuses"))
        return 0
    if "DATABASE_URL" in missing and not args.dry_run:
        die("run supabase.py first (DATABASE_URL/SUPABASE_* missing from .env.production.local)")
    env.write_prod({"CRON_SECRET": cron_secret}, args.dry_run)  # same value goes to GitHub (github.py)

    api = Api(env.get("RENDER_API_KEY"), args.dry_run)
    owner = pick_owner(api, args.owner)
    print(f"  workspace: {owner['name']} ({owner['type']})")
    svc = find_service(api, owner["id"], args.name)
    if svc:
        print(f"  found {svc['id']}")
    else:
        svc = create_service(api, owner["id"], args.name, values)
        if svc is None:
            return 0
        print(f"  created {svc['id']} (first deploy starts automatically)")
    fix_drift(api, svc)

    step("Environment variables (names only)")
    changed = sync_env(api, svc["id"], values)

    url = ((svc.get("serviceDetails") or {}).get("url") or f"https://{svc.get('slug', args.name)}.onrender.com").rstrip("/")
    env.write_prod({"RENDER_SERVICE_ID": svc["id"], "API_BASE_URL": url, "VITE_API_URL": url}, args.dry_run)
    print(f"\n  API: {url}\n  Dashboard: {svc.get('dashboardUrl', 'https://dashboard.render.com')}")
    if args.deploy and not args.dry_run:
        return trigger_and_wait(env, "", True, args.timeout)
    if changed:
        print("  Env var changes apply on the next deploy: python scripts/provision/render.py deploy --wait")
    print("\nNext: python scripts/provision/github.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
