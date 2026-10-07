#!/usr/bin/env python3
"""Create (or find) the Cloudflare Pages project `even` for direct uploads, and record its URL.

    python scripts/provision/cloudflare.py [--dry-run] [--project even]

Needs CLOUDFLARE_API_TOKEN (Account > Cloudflare Pages > Edit) and CLOUDFLARE_ACCOUNT_ID in .env.
No `source` block, so it's a Direct Upload project: GitHub Actions deploys web/dist with Wrangler,
and Cloudflare never builds from Git (no build minutes used).
API: POST/GET /accounts/{account_id}/pages/projects[/{name}] (Cloudflare API v4, "Pages Write").
Writes PAGES_URL and CLOUDFLARE_PROJECT_NAME to .env.production.local.
"""

from __future__ import annotations

import argparse

from _common import PROJECT_NAME, Env, HttpError, die, http, require, step

API = "https://api.cloudflare.com/client/v4"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="show the plan; no write calls")
    ap.add_argument("--project", default=PROJECT_NAME)
    ap.add_argument("--production-branch", default="main")
    args = ap.parse_args()
    env = Env()

    step(f"Cloudflare Pages project '{args.project}'")
    if not require(env, "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", dry_run=args.dry_run):
        print(f"  [dry-run] would GET/POST {API}/accounts/<account>/pages/projects "
              f"{{name: {args.project}, production_branch: {args.production_branch}}}")
        print(f"  [dry-run] would write PAGES_URL=https://{args.project}.pages.dev (or the assigned subdomain)")
        return 0
    token, account = env.get("CLOUDFLARE_API_TOKEN"), env.get("CLOUDFLARE_ACCOUNT_ID")
    base = f"{API}/accounts/{account}/pages/projects"

    project = None
    try:
        _, body = http("GET", f"{base}/{args.project}", token=token)
        project = body["result"]
        print(f"  found existing project (production branch: {project.get('production_branch')})")
    except HttpError as exc:
        if exc.status != 404:
            die(f"looking up the project failed: {exc}. Check the token has Account > Cloudflare Pages > Edit.")

    if project is None:
        payload = {"name": args.project, "production_branch": args.production_branch}
        if args.dry_run:
            print(f"  [dry-run] would POST {base} {payload}")
            subdomain = f"{args.project}.pages.dev"
        else:
            _, body = http("POST", base, token=token, body=payload)
            project = body["result"]
            print("  created (Direct Upload; deployments come from GitHub Actions)")
    if project is not None:
        if project.get("source"):
            print("  WARNING: this project is Git-connected. The workflow uses Direct Upload; "
                  "create a fresh project instead (Git-connected projects can't switch).")
        if project.get("production_branch") != args.production_branch and not args.dry_run:
            http("PATCH", f"{base}/{args.project}", token=token,
                 body={"production_branch": args.production_branch})
            print(f"  production branch set to {args.production_branch}")
        subdomain = project.get("subdomain") or f"{args.project}.pages.dev"

    url = f"https://{subdomain}"
    print(f"  Pages URL: {url}")
    if project is not None and project.get("domains"):
        print(f"  custom domains: {', '.join(project['domains'])}")
    env.write_prod({"PAGES_URL": url, "CLOUDFLARE_PROJECT_NAME": args.project}, args.dry_run)
    print("\nNext: python scripts/provision/supabase.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
