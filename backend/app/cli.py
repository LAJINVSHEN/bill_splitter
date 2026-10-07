"""Operator commands.

    python -m app.cli bootstrap-admin --username george [--email you@gmail.com --google]
    python -m app.cli bootstrap-admin --username george --existing-user-id <auth uuid>
    python -m app.cli dev-token --username alice [--hours 12]      (not in production)
    python -m app.cli dev-seed                                      (local demo data; fake auth only)
    python -m app.cli ensure-bucket                                 (Supabase Storage)

``bootstrap-admin`` prints the temporary password ONCE to your own terminal; it is
never logged or stored by the app.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import uuid

from sqlalchemy import select

from app.config import get_settings
from app.database import create_database
from app.devtools import dev_auth_enabled, mint_dev_token, seed
from app.models import Profile
from app.schemas.admin import AdminUserCreate


async def bootstrap_admin(args: argparse.Namespace) -> int:
    from app.integrations.supabase_admin import build_supabase_admin
    from app.services.admin import create_user
    from app.services.people import ensure_self

    settings = get_settings()
    db = create_database(settings, null_pool=True)
    try:
        async with db.sessionmaker() as session:
            if args.existing_user_id:
                uid = uuid.UUID(args.existing_user_id)
                if await session.get(Profile, uid) is not None:
                    print("A profile already exists for that user id.", file=sys.stderr)
                    return 1
                username = args.username.strip().lower()
                session.add(Profile(id=uid, username=username, email=args.email, display_name=args.display_name
                                    or username, role="admin", must_change_password=False,
                                    monthly_scan_quota=settings.default_user_monthly_quota,
                                    default_currency=settings.default_currency))
                await session.flush()
                await ensure_self(session, uid, args.display_name or username)
                await session.commit()
                print(f"Admin profile created for existing auth user {uid}.")
                return 0
            if await session.scalar(select(Profile.id).where(Profile.role == "admin")) is not None and not args.force:
                print("An admin already exists (use --force to add another).", file=sys.stderr)
                return 1
            auth = build_supabase_admin(settings)
            try:
                created = await create_user(session, settings, auth, AdminUserCreate(
                    username=args.username, display_name=args.display_name, email=args.email,
                    login="google" if args.google else "password", role="admin"))
            finally:
                await auth.aclose()
        print(f"Admin '{created.user.username}' created (id {created.user.id}, email {created.user.email}).")
        if created.temp_password:
            print(f"Temporary password (shown once, change it on first login): {created.temp_password}")
        return 0
    finally:
        await db.dispose()


async def dev_token(args: argparse.Namespace) -> int:
    settings = get_settings()
    if settings.is_production:
        print("dev-token is disabled in production.", file=sys.stderr)
        return 1
    if not settings.supabase_jwt_secret:
        print("SUPABASE_JWT_SECRET is not set.", file=sys.stderr)
        return 1
    db = create_database(settings, null_pool=True)
    try:
        async with db.sessionmaker() as session:
            uid = await session.scalar(select(Profile.id).where(Profile.username == args.username.lower()))
    finally:
        await db.dispose()
    if uid is None:
        print(f"No profile named {args.username!r}.", file=sys.stderr)
        return 1
    print(mint_dev_token(settings, uid, args.hours)[0])
    return 0


async def dev_seed(_: argparse.Namespace) -> int:
    settings = get_settings()
    if not dev_auth_enabled(settings):
        print("dev-seed needs ENVIRONMENT != production and SUPABASE_ADMIN_BACKEND=fake.", file=sys.stderr)
        return 1
    db = create_database(settings, null_pool=True)
    try:
        result = await seed(db.sessionmaker, settings)
    finally:
        await db.dispose()
    print(f"Seeded admin 'george' + 4 members and {len(result.bill_ids)} bills (idempotent).")
    print("Log in via POST /api/dev/auth/login with any seeded username and DEV_LOGIN_PASSWORD.")
    return 0


async def ensure_bucket(_: argparse.Namespace) -> int:
    from app.integrations.storage import SupabaseStorage

    settings = get_settings()
    storage = SupabaseStorage(settings.supabase_url, settings.supabase_service_role_key, settings.storage_bucket)
    try:
        await storage.ensure_bucket()
    finally:
        await storage.aclose()
    print(f"Bucket '{settings.storage_bucket}' is ready (private).")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("bootstrap-admin", help="create the first admin (Supabase user + profile)")
    p.add_argument("--username", required=True)
    p.add_argument("--display-name")
    p.add_argument("--email", help="real email (e.g. Gmail) instead of the synthetic username address")
    p.add_argument("--google", action="store_true", help="Google sign-in only (no temp password)")
    p.add_argument("--existing-user-id", help="only create the profile for an existing auth user")
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=bootstrap_admin)

    p = sub.add_parser("dev-token", help="mint a local HS256 access token for a profile")
    p.add_argument("--username", required=True)
    p.add_argument("--hours", type=float, default=12)
    p.set_defaults(func=dev_token)

    p = sub.add_parser("dev-seed", help="create/restore the deterministic local demo data (not in production)")
    p.set_defaults(func=dev_seed)

    p = sub.add_parser("ensure-bucket", help="create the private receipts bucket in Supabase Storage")
    p.set_defaults(func=ensure_bucket)

    args = parser.parse_args(argv)
    return asyncio.run(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
