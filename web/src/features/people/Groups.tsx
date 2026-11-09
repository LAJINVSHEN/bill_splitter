import { useState } from 'react'
import { Button } from '@/components/Button'
import { Avatar, EvenBadge, Money, Notice, SectionTitle } from '@/components/Display'
import { Dialog, useToast } from '@/components/Feedback'
import { TextField } from '@/components/Field'
import { Icon } from '@/components/Icon'
import { PaidToggle } from '@/components/PaidToggle'
import { useDeleteGroup, useGroups, usePeople, useRecordSettleUp, useSaveGroup, useSendPlan, useSettleUp, useUndoSettleUp } from '@/data/queries'
import { payLine } from '@/features/settle/logic'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { GroupOut, PersonOut, RecordView, SettlePayment, SettlePiece } from '@/lib/types'

/**
 * Groups are yours alone: a saved set of people to add to a bill in one tap, and a scope for
 * settling up. A group's plan simplifies what its friends owe each other across every bill you
 * can see; placeholders are listed apart, as the bills say.
 */
export function GroupsSection({ people }: { people: PersonOut[] }) {
  const groups = useGroups()
  const [editing, setEditing] = useState<GroupOut | 'new' | null>(null)
  const [open, setOpen] = useState<GroupOut | null>(null)
  const byId = new Map(people.map((p) => [p.id, p]))
  const list = groups.data ?? []
  return (
    <section aria-labelledby="groups-title">
      <SectionTitle
        id="groups-title"
        action={
          <Button variant="quiet" icon={<Icon name="plus" size={18} />} onClick={() => setEditing('new')}>
            New group
          </Button>
        }
      >
        Groups
      </SectionTitle>
      {list.length === 0 ? (
        <p className="border-t-[1.5px] border-ink pt-3 text-[15px] text-ink-2">Save who you often split with, then add them to a bill in one tap.</p>
      ) : (
        <ul className="border-t-[1.5px] border-ink">
          {list.map((g) => {
            const members = g.person_ids.map((id) => byId.get(id)).filter((p): p is PersonOut => Boolean(p))
            return (
              <li key={g.id} className="border-b border-rule">
                <button type="button" onClick={() => setOpen(g)} className="group flex min-h-[60px] w-full items-center gap-3 py-2 text-left">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-mist text-ink"><Icon name="group" size={20} /></span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[16px] font-semibold group-hover:text-cobalt">{g.name}</span>
                    <span className="truncate text-[14px] text-ink-2">{members.map((p) => p.name.split(' ')[0]).join(', ') || 'Nobody yet'}</span>
                  </span>
                  <span className="flex shrink-0 -space-x-1.5" aria-hidden="true">
                    {members.slice(0, 4).map((p) => (
                      <span key={p.id} className="rounded-full ring-2 ring-paper"><Avatar name={p.name} seed={p.color_seed} size={24} /></span>
                    ))}
                  </span>
                  <Icon name="next" size={16} className="shrink-0 text-ink-2" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {editing && <GroupEditor group={editing === 'new' ? null : editing} people={people} onClose={() => setEditing(null)} />}
      {open && (
        <GroupSheet
          group={list.find((g) => g.id === open.id) ?? open}
          onClose={() => setOpen(null)}
          onEdit={() => { setEditing(open); setOpen(null) }}
        />
      )}
    </section>
  )
}

function GroupEditor({ group, people, onClose }: { group: GroupOut | null; people: PersonOut[]; onClose: () => void }) {
  const save = useSaveGroup()
  const del = useDeleteGroup()
  const toast = useToast()
  const [name, setName] = useState(group?.name ?? '')
  const [ids, setIds] = useState<string[]>(group?.person_ids ?? [])
  const [error, setError] = useState<string | null>(null)
  const choices = people.filter((p) => !p.is_self)

  async function submit() {
    if (!name.trim()) return setError('Give the group a name.')
    try {
      await save.mutateAsync({ id: group?.id, name: name.trim(), person_ids: ids })
      toast(group ? 'Group saved' : `${name.trim()} saved`)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save. Try again.')
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={group ? 'Edit group' : 'New group'}
      footer={
        <>
          {group && (
            <Button variant="danger" className="mr-auto px-3" loading={del.isPending} onClick={() => del.mutate(group.id, { onSuccess: () => { toast('Group deleted'); onClose() } })}>
              Delete
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={save.isPending} onClick={() => void submit()}>Save</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <TextField label="Name" placeholder="Ski trip" value={name} maxLength={60} onChange={(e) => { setName(e.target.value); setError(null) }} error={error} />
        <fieldset>
          <legend className="mb-1.5 text-[15px] font-semibold">Who’s in it</legend>
          <ul className="border-t-[1.5px] border-ink">
            {choices.map((p) => (
              <li key={p.id} className="border-b border-rule">
                <label className="flex min-h-[52px] cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    className="h-[22px] w-[22px] shrink-0 accent-cobalt"
                    checked={ids.includes(p.id)}
                    onChange={(e) => setIds((list) => (e.target.checked ? [...list, p.id] : list.filter((x) => x !== p.id)))}
                  />
                  <Avatar name={p.name} seed={p.color_seed} />
                  <span className="min-w-0 flex-1 truncate text-[16px] font-medium">
                    {p.name}
                    {p.username && <span className="ml-1.5 text-[14px] font-semibold text-ink-2">@{p.username}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      </div>
    </Dialog>
  )
}

interface Marked {
  key: string
  view: RecordView
  currency: string
  payment: SettlePayment
  pieces: SettlePiece[]
}

const rowKey = (view: RecordView, currency: string, p: SettlePayment) =>
  `${view}|${currency}|${p.from_person.person_id}|${p.to_person.person_id}|${p.amount_cents}`

/** The group's plan: payments between friends (simplified), then placeholders as the bills say. */
function GroupSheet({ group, onClose, onEdit }: { group: GroupOut; onClose: () => void; onEdit: () => void }) {
  const people = usePeople()
  const plan = useSettleUp(null, group.id)
  const record = useRecordSettleUp()
  const undo = useUndoSettleUp()
  const send = useSendPlan()
  const toast = useToast()
  const [marked, setMarked] = useState<Marked[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const names = new Map((people.data ?? []).map((p) => [p.id, p.name]))
  const groups = plan.data?.groups ?? []
  const accounts = groups.some((g) => g.simplified.some((p) => !p.from_person.is_self || !p.to_person.is_self))

  async function mark(view: RecordView, currency: string, p: SettlePayment) {
    const key = rowKey(view, currency, p)
    setBusy(key)
    try {
      const out = await record.mutateAsync({
        view, currency, combine: null, group_id: group.id,
        from_person_id: p.from_person.person_id, to_person_id: p.to_person.person_id, amount_cents: p.amount_cents,
      })
      const pieces = out.applied ?? []
      setMarked((m) => [...m, { key, view, currency, payment: p, pieces }])
      if (pieces.some((x) => x.pending)) toast('Marked. Bill owners confirm the parts on their bills.')
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t save. Try again.', 'danger')
    } finally {
      setBusy(null)
    }
  }
  async function unmark(m: Marked) {
    setBusy(m.key)
    try {
      await undo.mutateAsync({ combine: null, group_id: group.id, pieces: m.pieces })
      setMarked((list) => list.filter((x) => x.key !== m.key))
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t undo. Try again.', 'danger')
    } finally {
      setBusy(null)
    }
  }
  async function sendPlan() {
    try {
      let n = 0
      for (const g of groups) n = Math.max(n, (await send.mutateAsync({ groupId: group.id, currency: g.currency, combine: null })).sent_to)
      toast(n ? `Sent to ${n === 1 ? '1 person' : `${n} people`}` : 'Nobody with an account in this plan')
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t send. Try again.', 'danger')
    }
  }

  const line = (view: RecordView, currency: string, p: SettlePayment, paid: boolean, onToggle: () => void) => {
    const key = rowKey(view, currency, p)
    return (
      <li key={key} className="grid min-h-[56px] grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-rule py-1.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex shrink-0 -space-x-1.5" aria-hidden="true">
            {[p.from_person, p.to_person].map((x) => (
              <span key={x.person_id} className="rounded-full ring-2 ring-paper"><Avatar name={x.name} seed={x.color_seed} size={22} /></span>
            ))}
          </span>
          <span className={cn('min-w-0 truncate text-[16px] font-semibold', paid && 'text-ink-2 line-through')}>
            {payLine({ from_person: label(p.from_person), to_person: label(p.to_person) })}
          </span>
        </span>
        <Money minor={p.amount_cents} currency={currency} code className={cn('text-[16px] font-bold', p.to_person.is_self && 'text-cobalt-ink')} />
        <PaidToggle paid={paid} received={p.to_person.is_self} busy={busy === key} onToggle={onToggle} label={payLine(p)} />
      </li>
    )
  }
  const label = (x: SettlePayment['from_person']) => ({
    ...x,
    name: x.owner_name ? `${x.name} (${x.owner_name.split(' ')[0]}’s)` : (names.get(x.person_id) ?? x.name).split(' ')[0] ?? x.name,
  })

  const done = (view: RecordView, currency: string) => marked.filter((m) => m.view === view && m.currency === currency)
  const empty = groups.length === 0 && marked.length === 0
  return (
    <Dialog open onClose={onClose} title={group.name}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap gap-x-6">
          <Button variant="quiet" icon={<Icon name="people" size={18} />} onClick={onEdit}>Edit group</Button>
          {accounts && (
            <Button variant="quiet" icon={<Icon name="share" size={18} />} loading={send.isPending} onClick={() => void sendPlan()}>
              Send plan
            </Button>
          )}
        </div>
        {plan.isPending ? (
          <p className="text-[15px] text-ink-2">Working out the plan…</p>
        ) : plan.isError ? (
          <Notice tone="danger">{plan.error.message}</Notice>
        ) : empty ? (
          <EvenBadge label="Everyone in it is even" />
        ) : (
          groups.map((g) => (
            <div key={g.currency} className="flex flex-col gap-5">
              {(g.simplified.length > 0 || done('simplified', g.currency).length > 0) && (
                <section aria-label={`${g.currency} plan`}>
                  <h3 className="display-sm mb-1.5 text-lg">To settle{groups.length > 1 ? ` · ${g.currency}` : ''}</h3>
                  <ul className="border-t-[1.5px] border-ink">
                    {g.simplified.map((p) => line('simplified', g.currency, p, false, () => void mark('simplified', g.currency, p)))}
                    {done('simplified', g.currency).map((m) => line('simplified', m.currency, m.payment, true, () => void unmark(m)))}
                  </ul>
                  {g.original.length > g.simplified.length && (
                    <p className="mt-2 text-[15px] text-ink-2">{g.original.length} debts between friends, simplified to {g.simplified.length}.</p>
                  )}
                </section>
              )}
              {((g.separate ?? []).length > 0 || done('separate', g.currency).length > 0) && (
                <section aria-label="Placeholders">
                  <h3 className="display-sm mb-1.5 text-lg">Not on even</h3>
                  <ul className="border-t-[1.5px] border-ink">
                    {(g.separate ?? []).map((p) => line('separate', g.currency, p, false, () => void mark('separate', g.currency, p)))}
                    {done('separate', g.currency).map((m) => line('separate', m.currency, m.payment, true, () => void unmark(m)))}
                  </ul>
                </section>
              )}
            </div>
          ))
        )}
      </div>
    </Dialog>
  )
}
