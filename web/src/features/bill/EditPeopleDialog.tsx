import { useState } from 'react'
import { Button } from '@/components/Button'
import { Notice } from '@/components/Display'
import { Dialog } from '@/components/Feedback'
import { useMe, usePutParticipants } from '@/data/queries'
import type { BillOut, UUID } from '@/lib/types'
import { PeoplePicker } from './PeoplePicker'

/** Add or remove people while assigning: the same picker as the People step, saved on Done. */
export function EditPeopleDialog({ bill, open, onClose }: { bill: BillOut; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Who’s splitting?">
      {open && <Body bill={bill} onClose={onClose} />}
    </Dialog>
  )
}

function Body({ bill, onClose }: { bill: BillOut; onClose: () => void }) {
  const me = useMe()
  const put = usePutParticipants(bill.id)
  const selfId = me.data?.self_person_id ?? bill.participants.find((p) => p.is_self)?.person_id
  const [selected, setSelected] = useState<UUID[]>(() => bill.participants.map((p) => p.person_id))
  const ordered = selfId && selected.includes(selfId) ? [selfId, ...selected.filter((id) => id !== selfId)] : selected
  const before = bill.participants.map((p) => p.person_id)
  const changed = ordered.length !== before.length || ordered.some((id, i) => id !== before[i])
  const losing = bill.participants.filter((p) => !selected.includes(p.person_id) && bill.items.some((i) => i.shares.some((s) => s.person_id === p.person_id)))

  return (
    <div className="flex flex-col gap-4">
      <PeoplePicker
        selected={ordered}
        onChange={setSelected}
        known={bill.participants.map((p) => ({ id: p.person_id, name: p.name, color_seed: p.color_seed, is_self: p.is_self }))}
        locked={selfId ? [selfId] : []}
      />
      {losing.length > 0 && (
        <Notice tone="warn">
          {losing.map((p) => p.name).join(', ')} {losing.length === 1 ? 'has' : 'have'} items. Removing {losing.length === 1 ? 'them' : 'them all'} takes them off those items.
        </Notice>
      )}
      {put.error && <Notice tone="danger">{put.error.message}</Notice>}
      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button loading={put.isPending} onClick={() => (changed ? put.mutate(ordered, { onSuccess: onClose }) : onClose())}>
          Done
        </Button>
      </div>
    </div>
  )
}
