#!/usr/bin/env python3
"""GitHub: Actions secrets/variables and the `production` environment, via the gh CLI.

    python scripts/provision/github.py [--dry-run] [--enable-deploy | --disable-deploy]
                                       [--rename-default-branch] [--render-auth api|hook]

Prerequisite: `gh auth login --scopes workflow` (the owner, once). Values come from
.env.production.local / .env and are piped to `gh secret set` on STDIN, never on the command line.

Repository secrets:   CRON_SECRET (the scheduled jobs run without an environment)
Environment `production` (deployable from `main` only):
                      VITE_API_URL, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_AUTH_EMAIL_DOMAIN,
                      CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
                      RENDER_API_KEY + RENDER_SERVICE_ID   (--render-auth api, default), or
                      RENDER_DEPLOY_HOOK_URL                (--render-auth hook; copy it from the dashboard)
Repository variables: API_BASE_URL, PAGES_URL, CLOUDFLARE_PROJECT_NAME,
                      CLOUD_DEPLOY_ENABLED (only with --enable-deploy / --disable-deploy: the kill switch)
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess

from _common import GITHUB_REPO, Env, die, step

# Repo-level only what the scheduled jobs need (they run without an environment). Everything a
# deploy uses lives in the `production` environment, which only `main` can use.
REPO_SECRETS = ["CRON_SECRET"]
DEPLOY_SECRETS = ["VITE_API_URL", "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_AUTH_EMAIL_DOMAIN",
                  "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]
REPO_VARIABLES = ["API_BASE_URL", "PAGES_URL", "CLOUDFLARE_PROJECT_NAME"]
# Owner tokens live in .env; everything else is production output and must never fall back to the
# LOCAL dev values in .env (e.g. the dev CRON_SECRET or an empty VITE_API_URL).
TOKENS = {"CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "RENDER_API_KEY", "RENDER_DEPLOY_HOOK_URL"}
ENVIRONMENT = "production"


def gh(*args: str, stdin: str | None = None, check: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(["gh", *args], input=stdin, text=True, capture_output=True)
    if check and proc.returncode != 0:
        # gh's stderr never contains the piped value; args never contain secrets.
        die(f"gh {' '.join(args[:3])} failed: {proc.stderr.strip()[:300]}")
    return proc


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="show the plan; no write calls")
    ap.add_argument("--repo", default=GITHUB_REPO)
    switch = ap.add_mutually_exclusive_group()
    switch.add_argument("--enable-deploy", action="store_true", help="set CLOUD_DEPLOY_ENABLED=true")
    switch.add_argument("--disable-deploy", action="store_true", help="set CLOUD_DEPLOY_ENABLED=false (kill switch)")
    ap.add_argument("--rename-default-branch", action="store_true", help="rename the default branch master → main")
    ap.add_argument("--render-auth", choices=["api", "hook"], default="api")
    args = ap.parse_args()
    env = Env()
    repo = args.repo

    def value(name: str) -> str:
        return env.get(name) if name in TOKENS else env.prod_get(name)

    step(f"GitHub {repo}")
    if not shutil.which("gh"):
        die("GitHub CLI (gh) not found. Install it from https://cli.github.com/")
    logged_in = gh("auth", "status", check=False).returncode == 0
    if not logged_in:
        if not args.dry_run:
            die("gh is not logged in. Run `gh auth login --scopes workflow` in your own terminal first.")
        print("  [dry-run] gh is not logged in; showing the plan only")

    def write(desc: str, *cmd: str, stdin: str | None = None) -> None:
        if args.dry_run or not logged_in:
            print(f"  [dry-run] would {desc}")
        else:
            gh(*cmd, stdin=stdin)
            print(f"  {desc}")

    if args.rename_default_branch:
        step("Default branch")
        current = (json.loads(gh("api", f"repos/{repo}").stdout).get("default_branch")
                   if logged_in else "master")
        if current == "main":
            print("  default branch is already main")
        elif current == "master":
            write("rename master → main (GitHub retargets PRs and redirects the old name)",
                  "api", "-X", "POST", f"repos/{repo}/branches/master/rename", "-f", "new_name=main")
        else:
            print(f"  default branch is {current!r}; not touching it")

    env_secrets = DEPLOY_SECRETS + (["RENDER_API_KEY", "RENDER_SERVICE_ID"] if args.render_auth == "api"
                                    else ["RENDER_DEPLOY_HOOK_URL"])
    missing = [k for k in REPO_SECRETS + env_secrets + REPO_VARIABLES if not value(k)]
    if missing:
        msg = f"not set in .env/.env.production.local: {', '.join(missing)} (run the earlier scripts first)"
        if args.dry_run:
            print(f"  [dry-run] {msg}")
        elif args.rename_default_branch:  # branch-only run before provisioning (see DEPLOYMENT.md step 2)
            print(f"\n  Secrets/variables skipped: {msg}")
            return 0
        else:
            die(msg)

    step(f"Environment '{ENVIRONMENT}' (deployments from main only)")
    write(f"create/update environment {ENVIRONMENT} with custom branch policy",
          "api", "-X", "PUT", f"repos/{repo}/environments/{ENVIRONMENT}", "--input", "-",
          stdin=json.dumps({"deployment_branch_policy": {"protected_branches": False,
                                                          "custom_branch_policies": True}}))
    has_main = False
    if logged_in and not args.dry_run:
        policies = json.loads(gh("api", f"repos/{repo}/environments/{ENVIRONMENT}/deployment-branch-policies").stdout)
        has_main = any(p.get("name") == "main" for p in policies.get("branch_policies", []))
    if not has_main:
        write("allow branch main to deploy", "api", "-X", "POST",
              f"repos/{repo}/environments/{ENVIRONMENT}/deployment-branch-policies",
              "-f", "name=main", "-f", "type=branch")

    step("Secrets (names only; values go over stdin)")
    for name in REPO_SECRETS:
        if value(name):
            write(f"set repo secret {name}", "secret", "set", name, "--repo", repo, stdin=value(name))
    for name in env_secrets:
        if value(name):
            write(f"set {ENVIRONMENT} secret {name}", "secret", "set", name, "--repo", repo,
                  "--env", ENVIRONMENT, stdin=value(name))

    step("Variables")
    for name in REPO_VARIABLES:
        if value(name):
            write(f"set variable {name}={value(name)}", "variable", "set", name, "--repo", repo,
                  "--body", value(name))
    if args.enable_deploy or args.disable_deploy:
        flag = "true" if args.enable_deploy else "false"
        write(f"set variable CLOUD_DEPLOY_ENABLED={flag}", "variable", "set", "CLOUD_DEPLOY_ENABLED",
              "--repo", repo, "--body", flag)
    else:
        print("  CLOUD_DEPLOY_ENABLED untouched (pass --enable-deploy when you're ready for push deploys)")

    print("\nNext: push main (see .skills/DEPLOYMENT.md), then python scripts/provision/smoke.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
