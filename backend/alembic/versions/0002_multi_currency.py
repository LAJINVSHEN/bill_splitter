"""multi-currency: saved fx rates, per-bill conversion snapshot, detected currency

* ``fx_rates``: the user's typed conversion rates (no FX feed), RLS deny-all like every table.
* ``bills.settle_currency`` + ``bills.fx_rate``: optional snapshot, both or neither.
* ``extraction_jobs.detected_currency``: receipt currency when it differs from the bill's.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-07 06:53:17.029653
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0002'
down_revision: str | None = '0001'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

API_ROLES = ("anon", "authenticated")


def _for_existing_roles(statement: str) -> str:
    """Same guard as 0001: only touch Supabase's API roles where they exist."""
    checks = "\n".join(
        f"  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN EXECUTE '{statement.format(role=role)}'; END IF;"
        for role in API_ROLES
    )
    return f"DO $$\nBEGIN\n{checks}\nEND\n$$;"


def upgrade() -> None:
    op.create_table('fx_rates',
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('owner_id', sa.UUID(), nullable=False),
    sa.Column('base', sa.String(length=3), nullable=False),
    sa.Column('quote', sa.String(length=3), nullable=False),
    sa.Column('rate', sa.Numeric(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("base ~ '^[A-Z]{3}$' AND quote ~ '^[A-Z]{3}$' AND base <> quote", name=op.f('ck_fx_rates_pair')),
    sa.CheckConstraint('rate > 0', name=op.f('ck_fx_rates_rate_positive')),
    sa.ForeignKeyConstraint(['owner_id'], ['profiles.id'], name=op.f('fk_fx_rates_owner_id_profiles'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_fx_rates')),
    sa.UniqueConstraint('owner_id', 'base', 'quote', name=op.f('uq_fx_rates_owner_id_base_quote'))
    )
    op.execute("ALTER TABLE public.fx_rates ENABLE ROW LEVEL SECURITY")
    op.execute(_for_existing_roles("REVOKE ALL ON TABLE public.fx_rates FROM {role}"))

    op.add_column('bills', sa.Column('settle_currency', sa.String(length=3), nullable=True))
    op.add_column('bills', sa.Column('fx_rate', sa.Numeric(), nullable=True))
    op.create_check_constraint(op.f('ck_bills_fx_pair'), 'bills', '(settle_currency IS NULL) = (fx_rate IS NULL)')
    op.create_check_constraint(
        op.f('ck_bills_settle_currency'), 'bills',
        "settle_currency IS NULL OR (settle_currency ~ '^[A-Z]{3}$' AND settle_currency <> currency)",
    )
    op.create_check_constraint(op.f('ck_bills_fx_rate_positive'), 'bills', 'fx_rate IS NULL OR fx_rate > 0')

    op.add_column('extraction_jobs', sa.Column('detected_currency', sa.String(length=3), nullable=True))


def downgrade() -> None:
    op.drop_column('extraction_jobs', 'detected_currency')
    op.drop_constraint(op.f('ck_bills_fx_rate_positive'), 'bills', type_='check')
    op.drop_constraint(op.f('ck_bills_settle_currency'), 'bills', type_='check')
    op.drop_constraint(op.f('ck_bills_fx_pair'), 'bills', type_='check')
    op.drop_column('bills', 'fx_rate')
    op.drop_column('bills', 'settle_currency')
    op.drop_table('fx_rates')
