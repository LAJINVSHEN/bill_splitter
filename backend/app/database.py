"""Async SQLAlchemy engine + session factory.

The engine is created in the app lifespan (``app.state.db``) so tests can build
one per test and production gets exactly one pool.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.config import Settings


@dataclass
class Database:
    engine: AsyncEngine
    sessionmaker: async_sessionmaker[AsyncSession]

    async def dispose(self) -> None:
        await self.engine.dispose()


def create_database(settings: Settings, *, null_pool: bool = False) -> Database:
    kwargs: dict[str, object] = {"connect_args": settings.db_connect_args, "pool_pre_ping": True}
    if null_pool:
        kwargs["poolclass"] = NullPool
    else:
        kwargs.update(
            pool_size=settings.db_pool_size,
            max_overflow=settings.db_max_overflow,
            pool_recycle=300,
        )
    engine = create_async_engine(settings.async_database_url, **kwargs)
    return Database(engine=engine, sessionmaker=async_sessionmaker(engine, expire_on_commit=False))


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    db: Database = request.app.state.db
    async with db.sessionmaker() as session:
        yield session
