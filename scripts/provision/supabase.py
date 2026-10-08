#!/usr/bin/env python3
"""Create/configure the Supabase project `even` (Free, ap-southeast-1) via the Management API.

    python scripts/provision/supabase.py [--dry-run] [--org <slug>] [--key-style auto|new|legacy]
    python scripts/provision/supabase.py --reset-db-password    # existing project, password lost
    python scripts/provision/supabase.py google                 # optional: enable Google sign-in

Needs SUPABASE_ACCESS_TOKEN (personal access token) in .env. Idempotent: an existing project
named `even` (or SUPABASE_PROJECT_REF) is reused, and settings are only PATCHed when they differ.

Steps: org → project (strong generated DB password, saved BEFORE the create call) → wait until
healthy → API keys (publishable/secret, or legacy anon/service_role) → legacy JWT secret (HS256
fallback) + signing-key info → session-pooler DATABASE_URL (port 5432, IPv4) → Auth config
(signups off, Site URL, redirect allow-list, JWT expiry) → private `receipts` bucket.
Writes the results to .env.production.local; prints only names and non-secret URLs.

Endpoints (Management API v1, https://api.supabase.com/api/v1-json, checked 2026-10-07):
GET /v1/organizations, GET /v1/organizations/{slug}, GET|POST /v1/projects, GET /v1/projects/{ref},
GET /v1/projects/{ref}/health, GET /v1/projects/{ref}/api-keys?reveal=true,
GET /v1/projects/{ref}/postgrest (jwt_secret), GET /v1/projects/{ref}/config/auth/signing-keys,
GET /v1/projects/{ref}/config/database/pooler, GET|PATCH /v1/projects/{ref}/config/auth,
PATCH /v1/projects/{ref}/database/password, GET /v1/projects/{ref}/storage/buckets.
The bucket itself is created with the project's Storage API (POST /storage/v1/bucket, service key).
"""

from __future__ import annotations

import argparse
import time
import urllib.parse

from _common import (PROJECT_NAME, Env, HttpError, die, http, pages_url, poll, random_secret, require,
                     step)

API = "https://api.supabase.com"
REGION = "ap-southeast-1"
BUCKET_MIME_TYPES = ["image/jpeg", "image/png", "image/heif", "application/pdf"]  # what the API stores
LOCAL_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000",
                 "http://127.0.0.1:3000", "http://localhost:4173", "http://127.0.0.1:4173"]
HEALTH_SERVICES = "auth,db,pooler,rest,storage"


class Api:
    def __init__(self, token: str, dry_run: bool) -> None:
        self.token, self.dry_run = token, dry_run

    def get(self, path: str):
        return http("GET", f"{API}{path}", token=self.token)[1]

    def write(self, method: str, path: str, body):
        if self.dry_run:
            keys = ", ".join(sorted(body)) if isinstance(body, dict) else ""
            print(f"  [dry-run] would {method} {path} ({keys})")
            return None
        return http(method, f"{API}{path}", token=self.token, body=body)[1]


def pick_org(api: Api, wanted: str) -> str:
    orgs = api.get("/v1/organizations")
    if wanted:
        for o in orgs:
            if wanted in (o["slug"], o["name"], o["id"]):
                return o["slug"]
        die(f"organization {wanted!r} not found. Available: {', '.join(o['name'] + ' (' + o['slug'] + ')' for o in orgs)}")
    if len(orgs) == 1:
        return orgs[0]["slug"]
    die("several organizations; pass --org <slug>: " + ", ".join(f"{o['name']} ({o['slug']})" for o in orgs))
    return ""


def find_project(api: Api, env: Env, org: str, name: str) -> dict | None:
    projects = api.get("/v1/projects")
    ref = env.prod_get("SUPABASE_PROJECT_REF")
    for p in projects:
        if (ref and p["ref"] == ref) or (not ref and p["name"] == name and p["organization_slug"] == org):
            return p
    if ref:
        die(f"SUPABASE_PROJECT_REF={ref} in .env.production.local isn't visible to this token")
    active = [p for p in projects if p["organization_slug"] == org and p["status"].startswith("ACTIVE")]
    if len(active) >= 2:
        print(f"  WARNING: the org already has {len(active)} active projects; Free allows 2. "
              "Pause/delete one or the create will fail.")
    return None


def wait_healthy(api: Api, ref: str) -> None:
    def project_ready():
        status = api.get(f"/v1/projects/{ref}")["status"]
        print(f"  project status: {status}")
        if status in ("INIT_FAILED", "REMOVED", "RESTORE_FAILED"):
            die(f"project is {status}")
        return status == "ACTIVE_HEALTHY"

    poll(project_ready, timeout=900, interval=20, what="project ACTIVE_HEALTHY")

    def services_ready():
        try:
            items = api.get(f"/v1/projects/{ref}/health?services={HEALTH_SERVICES}")
        except HttpError as exc:
            print(f"  health check: {exc}")
            return False
        bad = [s["name"] for s in items if not s.get("healthy")]
        print("  services healthy" if not bad else f"  waiting for: {', '.join(bad)}")
        return not bad

    poll(services_ready, timeout=600, interval=15, what="auth/db/pooler/rest/storage healthy")


def pick_keys(api: Api, ref: str, style: str) -> tuple[str, str, str]:
    keys = api.get(f"/v1/projects/{ref}/api-keys?reveal=true")
    new_pub = next((k for k in keys if k.get("type") == "publishable" and k.get("api_key")), None)
    new_sec = next((k for k in keys if k.get("type") == "secret" and k.get("api_key")), None)
    old_anon = next((k for k in keys if k.get("name") == "anon" and k.get("api_key")), None)
    old_srv = next((k for k in keys if k.get("name") == "service_role" and k.get("api_key")), None)
    if style in ("auto", "new") and new_pub and new_sec:
        return new_pub["api_key"], new_sec["api_key"], "publishable + secret (sb_...)"
    if style in ("auto", "legacy") and old_anon and old_srv:
        return old_anon["api_key"], old_srv["api_key"], "legacy anon + service_role (JWT)"
    die(f"no usable API key pair for --key-style {style} (found types: "
        f"{sorted({str(k.get('type')) + ':' + str(k.get('name')) for k in keys})})")
    return "", "", ""


def session_pooler_url(api: Api, ref: str, password: str) -> str:
    configs = api.get(f"/v1/projects/{ref}/config/database/pooler")
    primary = next((c for c in configs if c.get("database_type") == "PRIMARY"), configs[0] if configs else None)
    if not primary:
        die("no pooler config returned")
    # Same Supavisor host for both modes: 5432 = session (IPv4, prepared statements OK), 6543 = transaction.
    user = urllib.parse.quote(primary["db_user"], safe=".")
    return (f"postgresql://{user}:{urllib.parse.quote(password, safe='')}@{primary['db_host']}:5432/"
            f"{primary.get('db_name') or 'postgres'}")


def auth_settings(site: str) -> dict:
    allow = []
    for origin in [site, *LOCAL_ORIGINS]:
        allow += [origin, f"{origin}/**"]
    if site.endswith(".pages.dev"):
        allow.append(site.replace("https://", "https://*.", 1) + "/**")  # preview deployments
    return {
        "site_url": site,
        "uri_allow_list": ",".join(allow),
        "disable_signup": True,                   # accounts are created by the admin only
        "external_email_enabled": True,           # username+password logins use the email provider
        "external_phone_enabled": False,
        "external_anonymous_users_enabled": False,
        "jwt_exp": 3600,                          # 1 h access token; refresh tokens keep sessions for weeks
        "refresh_token_rotation_enabled": True,
        "security_refresh_token_reuse_interval": 10,
        "password_min_length": 8,
    }


def configure_auth(api: Api, ref: str, site: str) -> None:
    desired = auth_settings(site)
    current = api.get(f"/v1/projects/{ref}/config/auth")
    diff = {k: v for k, v in desired.items() if current.get(k) != v}
    if not diff:
        print("  auth config already as desired")
        return
    for k in sorted(diff):
        shown = desired[k] if k != "uri_allow_list" else f"{len(desired[k].split(','))} URLs"
        print(f"  {k}: {current.get(k) if k != 'uri_allow_list' else '...'} -> {shown}")
    api.write("PATCH", f"/v1/projects/{ref}/config/auth", diff)


def ensure_bucket(api: Api, ref: str, supabase_url: str, service_key: str, bucket: str, max_bytes: int) -> None:
    existing = api.get(f"/v1/projects/{ref}/storage/buckets")
    found = next((b for b in existing if b["id"] == bucket or b["name"] == bucket), None)
    spec = {"public": False, "file_size_limit": max_bytes, "allowed_mime_types": BUCKET_MIME_TYPES}
    headers = {"apikey": service_key}
    if service_key.startswith("eyJ"):  # legacy JWT key also goes in Authorization; sb_secret_ keys don't
        headers["Authorization"] = f"Bearer {service_key}"
    if found and not found.get("public"):
        print(f"  bucket '{bucket}' exists (private)")
        return
    method, url, body = (("PUT", f"{supabase_url}/storage/v1/bucket/{bucket}", spec) if found else
                         ("POST", f"{supabase_url}/storage/v1/bucket", {"id": bucket, "name": bucket, **spec}))
    if api.dry_run:
        print(f"  [dry-run] would {method} /storage/v1/bucket ({'make private' if found else 'create private'}, "
              f"limit {max_bytes} bytes, {len(BUCKET_MIME_TYPES)} mime types)")
        return
    http(method, url, body=body, headers=headers)
    print(f"  bucket '{bucket}' {'set to private' if found else 'created (private)'}")


def configure_google(api: Api, env: Env, ref: str) -> int:
    cid, secret = env.get("GOOGLE_CLIENT_ID"), env.get("GOOGLE_CLIENT_SECRET")
    site = pages_url(env)
    print(f"  Google Cloud > OAuth client (Web):\n    JS origins: {site}, http://localhost:5173, http://127.0.0.1:5173\n"
          f"    Authorized redirect URI: https://{ref}.supabase.co/auth/v1/callback")
    if not (cid and secret):
        print("  Put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, then re-run `supabase.py google`.")
        return 0 if api.dry_run else 1
    api.write("PATCH", f"/v1/projects/{ref}/config/auth", {
        "external_google_enabled": True, "external_google_client_id": cid, "external_google_secret": secret})
    print("  Google provider enabled. Signups stay disabled, so only emails the admin pre-created can sign in.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", nargs="?", default="provision", choices=["provision", "google"])
    ap.add_argument("--dry-run", action="store_true", help="show the plan; no write calls")
    ap.add_argument("--org", default="", help="organization slug/name (needed if you have several)")
    ap.add_argument("--name", default=PROJECT_NAME)
    ap.add_argument("--key-style", default="auto", choices=["auto", "new", "legacy"],
                    help="auto = publishable/secret keys when present, else legacy anon/service_role")
    ap.add_argument("--reset-db-password", action="store_true",
                    help="set a new DB password (only needed if the existing project's password was lost)")
    args = ap.parse_args()
    env = Env()

    step("Supabase")
    have_token = require(env, "SUPABASE_ACCESS_TOKEN", dry_run=args.dry_run)
    if not have_token:
        print(f"  [dry-run] plan: find org → find/create project '{args.name}' in {REGION} (Free) → wait healthy →"
              " keys → JWT secret → session pooler URL → auth config → private bucket → .env.production.local")
        print("  [dry-run] auth settings that would be applied:")
        for k, v in auth_settings(pages_url(env)).items():
            print(f"    {k} = {v}")
        return 0
    api = Api(env.get("SUPABASE_ACCESS_TOKEN"), args.dry_run)

    org = pick_org(api, args.org)
    plan = api.get(f"/v1/organizations/{org}").get("plan")
    print(f"  organization: {org} (plan: {plan})")
    if plan and plan != "free":
        print("  WARNING: org is not on Free. Keep the Spend Cap ON in Billing to avoid overage.")

    project = find_project(api, env, org, args.name)
    if args.command == "google":
        if not project:
            die("no Supabase project yet; run `supabase.py` first")
        return configure_google(api, env, project["ref"])
    password = env.prod_get("SUPABASE_DB_PASSWORD")
    if project:
        ref = project["ref"]
        print(f"  using project {project['name']} ({ref}, {project['region']}, {project['status']})")
        if project["region"] != REGION:
            print(f"  WARNING: region is {project['region']}, expected {REGION} (next to Render Singapore)")
        if args.reset_db_password:
            password = random_secret(32)
            env.write_prod({"SUPABASE_DB_PASSWORD": password}, args.dry_run)  # saved before the change
            api.write("PATCH", f"/v1/projects/{ref}/database/password", {"password": password})
            print("  database password reset")
        elif not password and args.dry_run:
            print("  [dry-run] SUPABASE_DB_PASSWORD missing; the real run stops and asks for --reset-db-password")
            password = "<password>"
        elif not password:
            die("SUPABASE_DB_PASSWORD isn't in .env.production.local for this existing project. "
                "Re-run with --reset-db-password to set a new one (the API never returns the old one).")
    else:
        password = password or random_secret(32)
        env.write_prod({"SUPABASE_DB_PASSWORD": password}, args.dry_run)  # saved before create: never lost
        created = api.write("POST", "/v1/projects", {
            "name": args.name, "organization_slug": org, "db_pass": password,
            "region_selection": {"type": "specific", "code": REGION}})
        if created is None:
            print(f"  [dry-run] would create project '{args.name}' in {REGION}; stopping the plan here")
            return 0
        ref = created["ref"]
        env.write_prod({"SUPABASE_PROJECT_REF": ref}, args.dry_run)
        print(f"  created project {ref}; provisioning takes a few minutes")
        time.sleep(30)

    step("Waiting for the project to be healthy")
    wait_healthy(api, ref)

    step("Keys, JWT and database URL")
    supabase_url = f"https://{ref}.supabase.co"
    anon, service, kind = pick_keys(api, ref, args.key_style)
    print(f"  API keys: {kind}")
    try:
        jwt_secret = api.get(f"/v1/projects/{ref}/postgrest").get("jwt_secret") or ""
    except HttpError as exc:
        print(f"  legacy JWT secret unavailable ({exc}); JWKS verification will be used")
        jwt_secret = ""
    try:
        signing = api.get(f"/v1/projects/{ref}/config/auth/signing-keys").get("keys", [])
        in_use = [k["algorithm"] for k in signing if k.get("status") == "in_use"]
        print(f"  access tokens signed with: {', '.join(in_use) or 'legacy HS256 secret'} "
              f"(backend verifies JWKS {supabase_url}/auth/v1/.well-known/jwks.json, HS256 fallback "
              f"{'available' if jwt_secret else 'not available'})")
    except HttpError as exc:
        print(f"  signing keys: {exc}")
    database_url = session_pooler_url(api, ref, password)
    print("  DATABASE_URL: Supavisor session pooler, port 5432")

    step("Auth configuration")
    site = pages_url(env)
    configure_auth(api, ref, site)

    step("Storage")
    bucket = env.get("STORAGE_BUCKET", "receipts")
    max_bytes = int(env.get("SCAN_MAX_FILE_BYTES", "4194304"))
    ensure_bucket(api, ref, supabase_url, service, bucket, max_bytes)

    step("Saving production values")
    email_domain = env.get("AUTH_EMAIL_DOMAIN", "users.even.app")
    env.write_prod({
        "SUPABASE_PROJECT_REF": ref,
        "SUPABASE_URL": supabase_url,
        "SUPABASE_ANON_KEY": anon,
        "SUPABASE_SERVICE_ROLE_KEY": service,
        "SUPABASE_JWT_SECRET": jwt_secret,
        "DATABASE_URL": database_url,
        "AUTH_EMAIL_DOMAIN": email_domain,
        "STORAGE_BUCKET": bucket,
        "VITE_SUPABASE_URL": supabase_url,
        "VITE_SUPABASE_ANON_KEY": anon,
        "VITE_AUTH_EMAIL_DOMAIN": email_domain,
    }, args.dry_run)
    print(f"\n  Supabase URL: {supabase_url}\n  Site URL: {site}\n  Dashboard: https://supabase.com/dashboard/project/{ref}")
    print("\nNext: python scripts/provision/render.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
