"""profiles.payment_note (how friends pay the owner back)

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-07 09:30:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0003'
down_revision: str | None = '0002'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('profiles', sa.Column('payment_note', sa.Text(), nullable=True))
    op.create_check_constraint(op.f('ck_profiles_payment_note_len'), 'profiles',
                               'payment_note IS NULL OR char_length(payment_note) BETWEEN 1 AND 200')


def downgrade() -> None:
    op.drop_constraint(op.f('ck_profiles_payment_note_len'), 'profiles', type_='check')
    op.drop_column('profiles', 'payment_note')
