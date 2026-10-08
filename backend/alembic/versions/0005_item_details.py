"""bill_items.details (unpriced component lines folded into a priced item)

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-08 10:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0005'
down_revision: str | None = '0004'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('bill_items', sa.Column('details', sa.Text(), nullable=True))
    op.create_check_constraint(op.f('ck_bill_items_details_len'), 'bill_items',
                               'details IS NULL OR char_length(details) <= 500')


def downgrade() -> None:
    op.drop_constraint(op.f('ck_bill_items_details_len'), 'bill_items', type_='check')
    op.drop_column('bill_items', 'details')
