#!/usr/bin/env python3
"""Create the first admin in PRODUCTION by running the backend CLI in the production image.

    python scripts/provision/bootstrap.py --username george [--display-name George]
    python scripts/provision/bootstrap.py --username george --email you@gmail.com --google
    python scripts/provision/bootstrap.py --username george --migrate --dry-run

Run it in YOUR OWN terminal after the first Render deploy is live (render-start.sh has applied the
migrations by then; --migrate runs `alembic upgrade head` first if you need it earlier).
It builds backend/Dockerfile.render and runs, with production settings from .env.production.local:
  python -m app.cli ensure-bucket             (idempotent; supabase.py already created it)
  python -m app.cli bootstrap-admin ...       (prints the temporary password ONCE, here only)
The settings go to Docker through a temporary --env-file that is deleted afterwards; nothing is
printed except the CLI's own output.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import tempfile

from _common import ROOT, Env, die, pages_url, step
from render import desired_env

IMAGE = "even-api:prod-cli"


def run(cmd: list[str], dry_run: bool) -> None:
    shown = " ".join(cmd)
    if dry_run:
        print(f"  [dry-run] {shown}")
        return
    print(f"  $ {shown}")
    if subprocess.run(cmd, cwd=ROOT).returncode != 0:
        die(f"command failed: {cmd[0]} {cmd[1]}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--username", required=True)
    ap.add_argument("--display-name", default="")
    ap.add_argument("--email", default="", help="real email (Google sign-in) instead of the synthetic address")
    ap.add_argument("--google", action="store_true", help="Google sign-in only (no temp password)")
    ap.add_argument("--migrate", action="store_true", help="run alembic upgrade head first")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    env = Env()

    step("Bootstrap the first admin (production)")
    if not shutil.which("docker"):
        die("Docker is required")
    values, missing = desired_env(env, pages_url(env), env.prod_get("CRON_SECRET"))
    needed = [k for k in ("DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY") if k in missing]
    if needed and not args.dry_run:
        die(f"{', '.join(needed)} missing from .env.production.local; run supabase.py first")

    run(["docker", "build", "-q", "-f", "backend/Dockerfile.render", "-t", IMAGE, "backend"], args.dry_run)
    fd, env_path = tempfile.mkstemp(prefix="even-prod-", suffix=".env")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write("".join(f"{k}={v}\n" for k, v in values.items()))
        base = ["docker", "run", "--rm", "--env-file", env_path, IMAGE, "python", "-m"]
        if args.migrate:
            run(base[:-2] + ["alembic", "upgrade", "head"], args.dry_run)
        run(base + ["app.cli", "ensure-bucket"], args.dry_run)
        admin = base + ["app.cli", "bootstrap-admin", "--username", args.username]
        if args.display_name:
            admin += ["--display-name", args.display_name]
        if args.email:
            admin += ["--email", args.email]
        if args.google:
            admin.append("--google")
        run(admin, args.dry_run)
    finally:
        os.remove(env_path)
    if not args.dry_run:
        print("\n  Sign in at the Pages URL with that username and temporary password; you'll be asked to change it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
