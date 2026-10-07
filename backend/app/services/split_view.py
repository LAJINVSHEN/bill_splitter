"""Maps a loaded Bill (items, shares, charges, participants) onto the pure core and back.

This is the ONE place split results are derived; the bill page, history, share link,
settle-up and summary all call ``compute_bill_split``.
"""

from __future__ import annotations

from uuid import UUID

from app.core.receipt_validation import ReceiptCharge, ReceiptItem, ValidationResult, validate_receipt
from app.core.split import ItemInput, ShareInput, SplitInput, SplitResult, compute_split
from app.models import Bill, BillParticipant
from app.schemas.bills import (
    SplitIssueOut,
    SplitItemShareOut,
    SplitOut,
    SplitPersonOut,
    ValidationErrorOut,
    ValidationOut,
    ValidationWarningOut,
)


def effective_grand_total(bill: Bill) -> int:
    if bill.grand_total_cents is not None:
        return bill.grand_total_cents
    return sum(i.total_price_cents for i in bill.items)


def effective_payer(bill: Bill) -> UUID | None:
    """The bill's payer if set and on the bill, else the owner's own person if on the bill."""
    pids = {p.person_id for p in bill.participants}
    if bill.payer_person_id in pids:
        return bill.payer_person_id
    me = next((p.person_id for p in bill.participants if p.person.is_self), None)
    return me


def compute_bill_split(bill: Bill) -> SplitResult:
    items = tuple(
        ItemInput(
            id=str(item.id), name=item.name, total_cents=item.total_price_cents, mode=item.split_mode,
            shares=tuple(ShareInput(person_id=str(s.person_id), weight=s.weight, amount_cents=s.amount_cents)
                         for s in item.shares),
        )
        for item in bill.items
    )
    participants = tuple(str(p.person_id) for p in bill.participants)
    return compute_split(SplitInput(participants=participants, items=items,
                                    grand_total_cents=effective_grand_total(bill)))


def outstanding_cents(total_cents: int, participant: BillParticipant, is_payer: bool) -> int:
    if is_payer:
        return 0
    paid = (participant.settled_amount_cents or 0) if participant.settled_at else 0
    return max(total_cents - paid, 0)


def split_out(bill: Bill, result: SplitResult | None = None) -> SplitOut:
    result = result or compute_bill_split(bill)
    payer = effective_payer(bill)
    item_names = {str(i.id): i.name for i in bill.items}
    parts = {str(p.person_id): p for p in bill.participants}
    people: list[SplitPersonOut] = []
    for pr in result.people:
        part = parts[pr.person_id]
        is_payer = part.person_id == payer
        people.append(SplitPersonOut(
            person_id=part.person_id, name=part.person.name, color_seed=part.person.color_seed,
            is_self=part.person.is_self, is_payer=is_payer, items_cents=pr.items_cents,
            adjustment_cents=pr.adjustment_cents, total_cents=pr.total_cents,
            items=[SplitItemShareOut(item_id=UUID(iid), name=item_names.get(iid, ""), share_cents=c)
                   for iid, c in pr.item_shares],
            settled_at=part.settled_at, settled_amount_cents=part.settled_amount_cents,
            outstanding_cents=outstanding_cents(pr.total_cents, part, is_payer),
        ))
    return SplitOut(
        currency=bill.currency, grand_total_cents=result.grand_total_cents, all_items_cents=result.all_items_cents,
        assigned_items_cents=result.assigned_items_cents, payer_person_id=payer, people=people,
        unassigned_item_ids=[UUID(i) for i in result.unassigned_item_ids],
        issues=[SplitIssueOut(code=i.code, message=i.message, item_id=UUID(i.item_id) if i.item_id else None,
                              person_id=UUID(i.person_id) if i.person_id else None,
                              expected_cents=i.expected_cents, actual_cents=i.actual_cents)
                for i in result.issues],
        is_complete=result.is_complete,
        outstanding_total_cents=sum(p.outstanding_cents for p in people),
    )


def validate_bill(bill: Bill) -> ValidationResult | None:
    if not bill.items and bill.grand_total_cents is None:
        return None
    return validate_receipt(
        [ReceiptItem(i.name, i.quantity, i.unit_price_cents, i.total_price_cents) for i in bill.items],
        [ReceiptCharge(c.name, c.amount_cents) for c in bill.charges],
        bill.grand_total_cents,
        bill.subtotal_cents,
    )


def validation_out(result: ValidationResult, item_ids: list[UUID] | None = None) -> ValidationOut:
    return ValidationOut(
        ok=result.ok, tax_scenario=result.tax_scenario, items_total_cents=result.items_total_cents,
        charges_total_cents=result.charges_total_cents, grand_total_cents=result.grand_total_cents,
        provided_subtotal_cents=result.provided_subtotal_cents, final_subtotal_cents=result.final_subtotal_cents,
        message=result.message,
        errors=[ValidationErrorOut(code=e.code, message=e.message, technical=e.technical) for e in result.errors],
        warnings=[ValidationWarningOut(
            code=w.code, item_index=w.item_index,
            item_id=item_ids[w.item_index] if item_ids and w.item_index < len(item_ids) else None,
            message=w.message, expected_cents=w.expected_cents, actual_cents=w.actual_cents,
        ) for w in result.warnings],
    )
