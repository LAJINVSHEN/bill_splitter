"""extraction_jobs.llm_reserved_micros (atomic LLM budget reservation)

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-08 11:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0006'
down_revision: str | None = '0005'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('extraction_jobs', sa.Column('llm_reserved_micros', sa.BigInteger(), server_default='0',
                                               nullable=False))
    op.create_check_constraint(op.f('ck_extraction_jobs_llm_reserved_nonneg'), 'extraction_jobs',
                               'llm_reserved_micros >= 0')


def downgrade() -> None:
    op.drop_constraint(op.f('ck_extraction_jobs_llm_reserved_nonneg'), 'extraction_jobs', type_='check')
    op.drop_column('extraction_jobs', 'llm_reserved_micros')
