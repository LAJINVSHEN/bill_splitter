"""Azure F0 hard gate: per-job page reservations + provider pause month

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-07 11:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0004'
down_revision: str | None = '0003'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('extraction_jobs',
                  sa.Column('pages_reserved', sa.Integer(), server_default='0', nullable=False))
    op.add_column('app_settings', sa.Column('provider_paused_month', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('app_settings', 'provider_paused_month')
    op.drop_column('extraction_jobs', 'pages_reserved')
