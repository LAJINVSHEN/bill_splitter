"""sharing v2: derived share tokens (one active link per scope) and payment claims

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-10 12:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0007'
down_revision: str | None = '0006'
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
    # Legacy links keep their random token ('random'); new ones are derived from the link id ('derived'),
    # so the server can show them again and there's one active derived link per scope.
    op.add_column('share_links', sa.Column('token_kind', sa.Text(), server_default='random', nullable=False))
    op.create_check_constraint(op.f('ck_share_links_token_kind'), 'share_links', "token_kind IN ('random', 'derived')")
    op.create_index('uq_share_links_active_person', 'share_links', ['bill_id', 'person_id'], unique=True,
                    postgresql_where=sa.text("revoked_at IS NULL AND token_kind = 'derived' AND person_id IS NOT NULL"))
    op.create_index('uq_share_links_active_group', 'share_links', ['bill_id'], unique=True,
                    postgresql_where=sa.text("revoked_at IS NULL AND token_kind = 'derived' AND person_id IS NULL"))

    op.create_table('payment_claims',
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('bill_id', sa.UUID(), nullable=False),
    sa.Column('person_id', sa.UUID(), nullable=False),
    sa.Column('owner_id', sa.UUID(), nullable=False),
    sa.Column('share_link_id', sa.UUID(), nullable=True),
    sa.Column('via', sa.Text(), nullable=False),
    sa.Column('amount_cents', sa.BigInteger(), nullable=False),
    sa.Column('currency', sa.String(length=3), nullable=False),
    sa.Column('expected_total_cents', sa.BigInteger(), nullable=False),
    sa.Column('status', sa.Text(), server_default='claimed', nullable=False),
    sa.Column('client_key', sa.UUID(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint("via IN ('person_link', 'group_link')", name=op.f('ck_payment_claims_via')),
    sa.CheckConstraint('amount_cents > 0', name=op.f('ck_payment_claims_amount_positive')),
    sa.CheckConstraint("currency ~ '^[A-Z]{3}$'", name=op.f('ck_payment_claims_currency')),
    sa.CheckConstraint("status IN ('claimed', 'confirmed', 'rejected', 'withdrawn', 'superseded', 'reverted')",
                       name=op.f('ck_payment_claims_status')),
    sa.ForeignKeyConstraint(['bill_id', 'person_id'], ['bill_participants.bill_id', 'bill_participants.person_id'],
                            name=op.f('fk_payment_claims_bill_id_bill_participants'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['owner_id'], ['profiles.id'], name=op.f('fk_payment_claims_owner_id_profiles'),
                            ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['share_link_id'], ['share_links.id'],
                            name=op.f('fk_payment_claims_share_link_id_share_links'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_payment_claims')),
    sa.UniqueConstraint('share_link_id', 'client_key', name=op.f('uq_payment_claims_share_link_id_client_key'))
    )
    op.create_index('uq_payment_claims_open', 'payment_claims', ['bill_id', 'person_id'], unique=True,
                    postgresql_where=sa.text("status = 'claimed'"))
    op.create_index('ix_payment_claims_owner_open', 'payment_claims', ['owner_id'],
                    postgresql_where=sa.text("status = 'claimed'"))
    op.create_index('ix_payment_claims_share_link_id', 'payment_claims', ['share_link_id'])
    op.execute("ALTER TABLE public.payment_claims ENABLE ROW LEVEL SECURITY")
    op.execute(_for_existing_roles("REVOKE ALL ON TABLE public.payment_claims FROM {role}"))


def downgrade() -> None:
    op.drop_index('ix_payment_claims_share_link_id', table_name='payment_claims')
    op.drop_index('ix_payment_claims_owner_open', table_name='payment_claims')
    op.drop_index('uq_payment_claims_open', table_name='payment_claims')
    op.drop_table('payment_claims')
    op.drop_index('uq_share_links_active_group', table_name='share_links')
    op.drop_index('uq_share_links_active_person', table_name='share_links')
    op.drop_constraint(op.f('ck_share_links_token_kind'), 'share_links', type_='check')
    op.drop_column('share_links', 'token_kind')
