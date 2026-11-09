"""user profiles: unique emails, friendships, placeholder links, mailbox, access requests,
groups, shared-bill versions + edit log, in-app claims

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-09 12:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0008'
down_revision: str | None = '0007'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

API_ROLES = ("anon", "authenticated")
NEW_TABLES = ("friendships", "person_links", "mailbox_items", "access_requests", "groups", "group_members",
              "bill_edits")


def _for_existing_roles(statement: str) -> str:
    """Same guard as 0001: only touch Supabase's API roles where they exist."""
    checks = "\n".join(
        f"  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN EXECUTE '{statement.format(role=role)}'; END IF;"
        for role in API_ROLES
    )
    return f"DO $$\nBEGIN\n{checks}\nEND\n$$;"


def _uuid(name: str, nullable: bool = False, **kw) -> sa.Column:
    return sa.Column(name, sa.UUID(), nullable=nullable, **kw)


def _now(name: str = 'created_at') -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False)


def upgrade() -> None:
    # ---------------------------------------------------------------- profiles / people / bills / claims
    op.add_column('profiles', sa.Column('discoverable', sa.Boolean(), server_default=sa.text('true'), nullable=False))
    op.create_index('uq_profiles_email_lower', 'profiles', [sa.text('lower(email)')], unique=True,
                    postgresql_where=sa.text('email IS NOT NULL'))

    op.add_column('people', _uuid('linked_profile_id', nullable=True))
    op.create_foreign_key(op.f('fk_people_linked_profile_id_profiles'), 'people', 'profiles',
                          ['linked_profile_id'], ['id'], ondelete='SET NULL')
    op.create_check_constraint(op.f('ck_people_self_unlinked'), 'people',
                               'NOT (is_self AND linked_profile_id IS NOT NULL)')
    op.create_index('ix_people_linked_profile_id', 'people', ['linked_profile_id'])
    op.create_index('uq_people_owner_linked_active', 'people', ['owner_id', 'linked_profile_id'], unique=True,
                    postgresql_where=sa.text('linked_profile_id IS NOT NULL AND archived_at IS NULL'))

    op.add_column('bills', sa.Column('version', sa.Integer(), server_default='1', nullable=False))
    op.add_column('bills', _uuid('updated_by', nullable=True))
    op.create_foreign_key(op.f('fk_bills_updated_by_profiles'), 'bills', 'profiles', ['updated_by'], ['id'],
                          ondelete='SET NULL')

    op.add_column('payment_claims', _uuid('claimed_by', nullable=True))
    op.create_foreign_key(op.f('fk_payment_claims_claimed_by_profiles'), 'payment_claims', 'profiles',
                          ['claimed_by'], ['id'], ondelete='SET NULL')
    op.drop_constraint(op.f('ck_payment_claims_via'), 'payment_claims', type_='check')
    op.create_check_constraint(op.f('ck_payment_claims_via'), 'payment_claims',
                               "via IN ('person_link', 'group_link', 'app')")

    # ---------------------------------------------------------------- friendships
    op.create_table('friendships',
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    _uuid('requester_id'), _uuid('addressee_id', nullable=True),
    sa.Column('identifier', sa.Text(), nullable=False),
    sa.Column('status', sa.Text(), server_default='pending', nullable=False),
    _uuid('blocked_by', nullable=True),
    _now(),
    sa.Column('responded_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('ended_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint("status IN ('pending', 'accepted', 'declined', 'cancelled', 'ended', 'blocked')",
                       name=op.f('ck_friendships_status')),
    sa.CheckConstraint('addressee_id IS NULL OR addressee_id <> requester_id', name=op.f('ck_friendships_not_self')),
    sa.ForeignKeyConstraint(['requester_id'], ['profiles.id'], name=op.f('fk_friendships_requester_id_profiles'),
                            ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['addressee_id'], ['profiles.id'], name=op.f('fk_friendships_addressee_id_profiles'),
                            ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_friendships')),
    )
    op.create_index('uq_friendships_live_pair', 'friendships',
                    [sa.text('LEAST(requester_id, addressee_id)'), sa.text('GREATEST(requester_id, addressee_id)')],
                    unique=True, postgresql_where=sa.text(
                        "addressee_id IS NOT NULL AND status IN ('pending', 'accepted', 'blocked')"))
    op.create_index('uq_friendships_open_identifier', 'friendships', ['requester_id', 'identifier'], unique=True,
                    postgresql_where=sa.text("status = 'pending'"))
    op.create_index('ix_friendships_addressee_id', 'friendships', ['addressee_id'])

    # ---------------------------------------------------------------- placeholder → account links
    op.create_table('person_links',
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    _uuid('person_id'), _uuid('inviter_id'), _uuid('invitee_id'),
    sa.Column('status', sa.Text(), server_default='pending', nullable=False),
    _now(),
    sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint("status IN ('pending', 'accepted', 'declined', 'cancelled')",
                       name=op.f('ck_person_links_status')),
    sa.ForeignKeyConstraint(['person_id'], ['people.id'], name=op.f('fk_person_links_person_id_people'),
                            ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['inviter_id'], ['profiles.id'], name=op.f('fk_person_links_inviter_id_profiles'),
                            ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['invitee_id'], ['profiles.id'], name=op.f('fk_person_links_invitee_id_profiles'),
                            ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_person_links')),
    )
    op.create_index('uq_person_links_pending', 'person_links', ['person_id'], unique=True,
                    postgresql_where=sa.text("status = 'pending'"))
    op.create_index('ix_person_links_invitee_id', 'person_links', ['invitee_id'])

    # ---------------------------------------------------------------- mailbox
    op.create_table('mailbox_items',
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    _uuid('recipient_id'),
    sa.Column('kind', sa.Text(), nullable=False),
    _uuid('actor_id', nullable=True), _uuid('bill_id', nullable=True),
    sa.Column('data', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False),
    sa.Column('count', sa.Integer(), server_default='1', nullable=False),
    sa.Column('read_at', sa.DateTime(timezone=True), nullable=True),
    _now(), _now('updated_at'),
    sa.CheckConstraint("kind IN ('friend_accepted', 'friend_declined', 'link_accepted', 'link_declined', "
                       "'bill_added', 'bill_edited', 'claim_confirmed', 'claim_rejected', 'plan_sent')",
                       name=op.f('ck_mailbox_items_kind')),
    sa.ForeignKeyConstraint(['recipient_id'], ['profiles.id'], name=op.f('fk_mailbox_items_recipient_id_profiles'),
                            ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['actor_id'], ['profiles.id'], name=op.f('fk_mailbox_items_actor_id_profiles'),
                            ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['bill_id'], ['bills.id'], name=op.f('fk_mailbox_items_bill_id_bills'),
                            ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_mailbox_items')),
    )
    op.create_index('ix_mailbox_items_recipient_id_updated_at', 'mailbox_items', ['recipient_id', 'updated_at'])
    op.create_index('ix_mailbox_items_unread', 'mailbox_items', ['recipient_id'],
                    postgresql_where=sa.text('read_at IS NULL'))

    # ---------------------------------------------------------------- access requests
    op.create_table('access_requests',
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    _uuid('auth_user_id'),
    sa.Column('email', sa.Text(), nullable=False),
    sa.Column('name', sa.Text(), nullable=True),
    sa.Column('note', sa.Text(), nullable=True),
    sa.Column('status', sa.Text(), server_default='pending', nullable=False),
    _now(),
    sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
    _uuid('decided_by', nullable=True),
    sa.CheckConstraint("status IN ('pending', 'approved', 'rejected')", name=op.f('ck_access_requests_status')),
    sa.CheckConstraint('note IS NULL OR char_length(note) <= 300', name=op.f('ck_access_requests_note_len')),
    sa.ForeignKeyConstraint(['decided_by'], ['profiles.id'], name=op.f('fk_access_requests_decided_by_profiles'),
                            ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_access_requests')),
    sa.UniqueConstraint('auth_user_id', name=op.f('uq_access_requests_auth_user_id')),
    )
    op.create_index('ix_access_requests_status_created_at', 'access_requests', ['status', 'created_at'])

    # ---------------------------------------------------------------- groups
    op.create_table('groups',
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    _uuid('owner_id'),
    sa.Column('name', sa.Text(), nullable=False),
    _now(), _now('updated_at'),
    sa.CheckConstraint('char_length(name) BETWEEN 1 AND 60', name=op.f('ck_groups_name_len')),
    sa.ForeignKeyConstraint(['owner_id'], ['profiles.id'], name=op.f('fk_groups_owner_id_profiles'),
                            ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_groups')),
    )
    op.create_index('ix_groups_owner_id', 'groups', ['owner_id'])
    op.create_table('group_members',
    _uuid('group_id'), _uuid('person_id'),
    sa.Column('position', sa.SmallInteger(), nullable=False),
    sa.ForeignKeyConstraint(['group_id'], ['groups.id'], name=op.f('fk_group_members_group_id_groups'),
                            ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['person_id'], ['people.id'], name=op.f('fk_group_members_person_id_people'),
                            ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('group_id', 'person_id', name=op.f('pk_group_members')),
    )

    # ---------------------------------------------------------------- edit log
    op.create_table('bill_edits',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    _uuid('bill_id'), _uuid('actor_id', nullable=True),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('kind', sa.Text(), nullable=False),
    sa.Column('item_ids', postgresql.ARRAY(sa.UUID()), server_default=sa.text("'{}'"), nullable=False),
    _now(),
    sa.CheckConstraint("kind IN ('created', 'details', 'receipt', 'shares', 'people', 'quick', 'currency', "
                       "'status', 'settlement', 'scan')", name=op.f('ck_bill_edits_kind')),
    sa.ForeignKeyConstraint(['bill_id'], ['bills.id'], name=op.f('fk_bill_edits_bill_id_bills'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['actor_id'], ['profiles.id'], name=op.f('fk_bill_edits_actor_id_profiles'),
                            ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_bill_edits')),
    )
    op.create_index('ix_bill_edits_bill_id_version', 'bill_edits', ['bill_id', 'version'])

    for table in NEW_TABLES:
        op.execute(f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(_for_existing_roles(f"REVOKE ALL ON TABLE public.{table} FROM {{role}}"))
    op.execute(_for_existing_roles("REVOKE ALL ON SEQUENCE public.bill_edits_id_seq FROM {role}"))


def downgrade() -> None:
    for table in reversed(NEW_TABLES):
        op.drop_table(table)
    op.drop_constraint(op.f('ck_payment_claims_via'), 'payment_claims', type_='check')
    op.execute("UPDATE payment_claims SET via = 'person_link' WHERE via = 'app'")
    op.create_check_constraint(op.f('ck_payment_claims_via'), 'payment_claims', "via IN ('person_link', 'group_link')")
    op.drop_constraint(op.f('fk_payment_claims_claimed_by_profiles'), 'payment_claims', type_='foreignkey')
    op.drop_column('payment_claims', 'claimed_by')
    op.drop_constraint(op.f('fk_bills_updated_by_profiles'), 'bills', type_='foreignkey')
    op.drop_column('bills', 'updated_by')
    op.drop_column('bills', 'version')
    op.drop_index('uq_people_owner_linked_active', table_name='people')
    op.drop_index('ix_people_linked_profile_id', table_name='people')
    op.drop_constraint(op.f('ck_people_self_unlinked'), 'people', type_='check')
    op.drop_constraint(op.f('fk_people_linked_profile_id_profiles'), 'people', type_='foreignkey')
    op.drop_column('people', 'linked_profile_id')
    op.drop_index('uq_profiles_email_lower', table_name='profiles')
    op.drop_column('profiles', 'discoverable')
