import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/Button'
import { Avatar, Notice, PageTitle } from '@/components/Display'
import { TextField } from '@/components/Field'
import { Dialog, useToast } from '@/components/Feedback'
import { Icon } from '@/components/Icon'
import { useClearPeople, useCreatePerson, useDeletePerson, useFriendAction, useFriends, useMailbox, useMe, usePeople, useUpdatePerson } from '@/data/queries'
import { LoadError, SectionLoader } from '@/features/home/BillList'
import { cleanName, HUES, nameError, nearestHue } from '@/features/home/people'
import { first } from '@/features/mailbox/text'
import { AddFriendDialog } from '@/features/people/AddFriendDialog'
import { GroupsSection } from '@/features/people/Groups'
import { PersonDialog } from '@/features/people/PersonDialog'
import { MissingRates, SettleBreakdown, SettleCell, SettleControls, useSettle } from '@/features/settle/SettleBalance'
import { ApiError } from '@/lib/api'
import type { PersonOut } from '@/lib/types'

/** The hue fewest people already have, so new people look different from the last few. */
function freshHue(people: PersonOut[]): number {
  const used = new Map<number, number>(HUES.map((h) => [h.hue, 0]))
  for (const p of people) {
    const h = nearestHue(p.color_seed)
    used.set(h, (used.get(h) ?? 0) + 1)
  }
  return [...used.entries()].sort((a, b) => a[1] - b[1])[0]?.[0] ?? 200
}

function AddPerson({ people }: { people: PersonOut[] }) {
  const create = useCreatePerson()
  const toast = useToast()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const clean = cleanName(name)
    const problem = nameError(clean)
    if (problem) return setError(problem)
    try {
      await create.mutateAsync({ name: clean, color_seed: freshHue(people) })
      setName('')
      toast(`${clean} added`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t add them. Try again.')
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex items-start gap-2.5 md:max-w-[520px]">
      <div className="min-w-0 flex-1">
        <TextField
          label="Add a person"
          hideLabel
          placeholder="Name"
          value={name}
          maxLength={60}
          autoComplete="off"
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          error={error}
        />
      </div>
      <Button type="submit" variant="secondary" loading={create.isPending}>
        Add
      </Button>
    </form>
  )
}

/** Who a person is to you, in a few words after their name. */
function Tag({ p }: { p: PersonOut }) {
  if (p.is_self) return <span className="ml-2 text-[15px] font-semibold text-ink-2">You</span>
  if (p.username) return <span className="ml-2 text-[14px] font-semibold text-ink-2">@{p.username}</span>
  if (p.pending_link_to) return <span className="ml-2 text-[14px] font-semibold text-warn">asked {first(p.pending_link_to)}</span>
  return null
}

/** Friend requests sit in the Mailbox; People points there when there are some. */
function FriendRequests() {
  const mail = useMailbox()
  const n = (mail.data?.requests ?? []).filter((r) => r.kind === 'friend_request').length
  if (!n) return null
  return (
    <Link to="/mailbox" className="group flex min-h-12 items-center gap-2.5 border-y border-rule text-[16px] font-semibold">
      <Icon name="mail" className="text-cobalt" />
      <span className="flex-1">{n === 1 ? '1 friend request' : `${n} friend requests`}</span>
      <span className="text-[15px] font-bold text-cobalt group-hover:text-cobalt-ink">Open</span>
    </Link>
  )
}

function Blocked() {
  const friends = useFriends()
  const act = useFriendAction()
  const blocked = friends.data?.blocked ?? []
  if (!blocked.length) return null
  return (
    <section aria-labelledby="blocked-title">
      <h2 id="blocked-title" className="display-sm mb-1.5 text-lg">Blocked</h2>
      <ul className="border-t-[1.5px] border-ink">
        {blocked.map(({ account }) => (
          <li key={account.id} className="flex min-h-[52px] items-center gap-3 border-b border-rule">
            <Avatar name={account.name} seed={account.color_seed} />
            <span className="min-w-0 flex-1 truncate text-[16px] font-semibold">{account.name}</span>
            <Button variant="quiet" loading={act.isPending && act.variables?.id === account.id} onClick={() => act.mutate({ action: 'unblock', id: account.id })}>
              Unblock
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Delete a saved person (or all of them). Anyone still on a bill can't be deleted, ever: bills
 * are never erased from here. Archiving hides them and keeps every bill's history.
 */
function DeletePeople({ target, onClose }: { target: PersonOut | 'all'; onClose: () => void }) {
  const remove = useDeletePerson()
  const clear = useClearPeople()
  const update = useUpdatePerson()
  const toast = useToast()
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [onBills, setOnBills] = useState(false)
  const all = target === 'all'
  const phrase = 'DELETE ALL PEOPLE'
  const busy = remove.isPending || clear.isPending || update.isPending
  const archiving = update.isPending || (clear.isPending && clear.variables?.permanent === false)

  async function deletePeople() {
    if (busy || (all && confirmation !== phrase)) return
    setError(null)
    try {
      if (all) await clear.mutateAsync({ permanent: true })
      else await remove.mutateAsync(target.id)
      toast(all ? 'Saved people deleted' : `${target.name} deleted`)
      onClose()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'person_referenced') setOnBills(true)
      else setError(err instanceof ApiError ? err.message : 'Could not delete. Try again.')
    }
  }

  async function archive() {
    if (busy) return
    setError(null)
    try {
      if (all) await clear.mutateAsync({ permanent: false })
      else await update.mutateAsync({ id: target.id, archived: true })
      toast(all ? 'Saved people archived' : `${target.name} archived`)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not archive. Try again.')
    }
  }

  const archiveButton = (variant: 'primary' | 'quiet') => (
    <Button variant={variant} loading={archiving} disabled={busy} onClick={() => void archive()}>
      {all ? 'Archive people instead' : 'Archive instead'}
    </Button>
  )

  if (onBills) {
    return (
      <Dialog open onClose={() => { if (!busy) onClose() }} title={all ? 'Some people are on bills' : `${target.name} is on bills`}
        footer={<>
          <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          {archiveButton('primary')}
        </>}>
        <div className="flex flex-col gap-4" aria-busy={busy}>
          <p>{all ? 'People on a bill can’t be deleted' : 'Someone on a bill can’t be deleted'}, so no bill ever loses who was there or who paid.</p>
          <p>Archive them instead: they leave this list and bill pickers, and old bills keep their name.</p>
          {error && <Notice tone="danger">{error}</Notice>}
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog open onClose={() => { if (!busy) onClose() }} title={all ? 'Delete all saved people?' : 'Delete saved person?'}
      footer={<>
        <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button variant="danger" icon={<Icon name="trash" size={20} />} loading={remove.isPending || (clear.isPending && clear.variables?.permanent === true)}
          disabled={busy || (all && confirmation !== phrase)} onClick={() => void deletePeople()}>
          {all ? 'Delete all people' : 'Delete person'}
        </Button>
      </>}>
      <div className="flex flex-col gap-4" aria-busy={busy}>
        {!all && <p className="break-words font-semibold">{target.name}</p>}
        <p>{all ? 'All saved people, including archived people, will be permanently deleted. Me stays.' : 'This saved person will be permanently deleted.'} This cannot be undone.</p>
        <p>Anyone on a bill can’t be deleted. Bills are never erased from here.</p>
        {all && <TextField label={`Type ${phrase} to confirm`} value={confirmation} disabled={busy} autoComplete="off" onChange={(event) => setConfirmation(event.target.value)} />}
        {error && <Notice tone="danger">{error}</Notice>}
        {archiveButton('quiet')}
      </div>
    </Dialog>
  )
}

export default function PeoplePage() {
  const me = useMe()
  const people = usePeople()
  const settle = useSettle(me.data?.default_currency ?? 'SGD')
  const [deleting, setDeleting] = useState<PersonOut | 'all' | null>(null)
  const [adding, setAdding] = useState(false)
  const [managing, setManaging] = useState<PersonOut | null>(null)
  const list = people.data ?? []
  // archived people drop off the list, but anything they still owe or are owed stays visible
  const listed = new Set(list.map((p) => p.id))
  const unlisted = [...settle.people.values()].filter((e) => !listed.has(e.person.person_id))

  return (
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_var(--app-rail-w)] lg:gap-x-[var(--app-gutter)]">
      <div className="flex min-w-0 flex-col gap-6">
        <PageTitle
          sub={settle.note}
          actions={
            <>
              <SettleControls settle={settle} />
              <Button variant="secondary" icon={<Icon name="plus" size={18} />} onClick={() => setAdding(true)}>
                Add friend
              </Button>
            </>
          }
        >
          People
        </PageTitle>
        <MissingRates settle={settle} />
        <FriendRequests />
        {people.isPending ? (
          <SectionLoader label="Loading people" />
        ) : people.isError ? (
          <LoadError what="people" onRetry={() => void people.refetch()} retrying={people.isFetching} />
        ) : (
          <>
            <AddPerson people={list} />
            <ul aria-label="Saved people" className="border-t-[1.5px] border-ink">
              <li aria-hidden="true" className="hidden grid-cols-[32px_minmax(160px,22rem)_minmax(0,1fr)_44px] items-center gap-3 border-b border-rule py-2.5 text-[14px] font-semibold text-ink-2 md:grid">
                <span />
                <span>Name</span>
                <span>Balance</span>
                <span />
              </li>
              {list.map((p) => (
                <li key={p.id} className="group grid min-h-[56px] grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-x-3 border-b border-rule py-2 hover:bg-mist md:grid-cols-[32px_minmax(160px,22rem)_minmax(0,1fr)_44px]">
                  <span className="flex h-11 items-center md:h-10"><Avatar name={p.name} seed={p.color_seed} size={32} /></span>
                  <span className="flex min-h-11 min-w-0 items-center md:min-h-10">
                    {p.is_self ? (
                      <span className="block break-words text-base font-semibold">
                        {p.name}
                        <Tag p={p} />
                      </span>
                    ) : (
                      <button type="button" onClick={() => setManaging(p)} className="block break-words text-left text-base font-semibold hover:text-cobalt">
                        {p.name}
                        <Tag p={p} />
                      </button>
                    )}
                  </span>
                  <span className="hidden min-w-0 md:block"><SettleCell settle={settle} entry={settle.people.get(p.id)} onOpen={() => settle.openDetail(settle.people.get(p.id)?.person ?? null)} /></span>
                  {/* Desktop: revealed on row hover/focus in reserved width (nothing shifts); always shown on touch. */}
                  <span className="flex h-11 items-center justify-end md:h-10 md:opacity-0 md:transition-opacity md:group-focus-within:opacity-100 md:group-hover:opacity-100 pointer-coarse:opacity-100">
                    {!p.is_self && !p.account_id ? (
                      <Button variant="quiet" className="h-11 w-11 shrink-0 p-0 text-danger" aria-label={`Delete ${p.name}`} title={`Delete ${p.name}`} onClick={() => setDeleting(p)}>
                        <Icon name="trash" size={20} />
                      </Button>
                    ) : (
                      <span className="w-11 shrink-0" />
                    )}
                  </span>
                  {/* phones: the balance gets its own full-width line under the name */}
                  <span className="col-span-2 col-start-2 min-w-0 md:hidden"><SettleCell settle={settle} entry={settle.people.get(p.id)} onOpen={() => settle.openDetail(settle.people.get(p.id)?.person ?? null)} /></span>
                </li>
              ))}
              {unlisted.map((e) => (
                <li key={e.person.person_id} className="grid min-h-[56px] grid-cols-[32px_minmax(0,1fr)] items-start gap-x-3 border-b border-rule py-2 md:grid-cols-[32px_minmax(160px,22rem)_minmax(0,1fr)_44px]">
                  <span className="flex h-11 items-center md:h-10"><Avatar name={e.person.name} seed={e.person.color_seed} size={32} /></span>
                  <span className="flex min-h-11 min-w-0 items-center md:min-h-10">
                    <span className="block break-words text-base font-semibold">
                      {e.person.name}
                      <span className="ml-2 text-[15px] font-semibold text-ink-2">
                        {e.person.owner_name ? `${first(e.person.owner_name)}’s` : e.person.account_id ? 'On shared bills' : 'Archived'}
                      </span>
                    </span>
                  </span>
                  <span className="hidden min-w-0 md:block"><SettleCell settle={settle} entry={e} onOpen={() => settle.openDetail(e.person)} /></span>
                  <span className="col-start-2 min-w-0 md:hidden"><SettleCell settle={settle} entry={e} onOpen={() => settle.openDetail(e.person)} /></span>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="border-t border-rule pt-3">
          <Button variant="quiet" className="text-danger" icon={<Icon name="trash" size={20} />} onClick={() => setDeleting('all')}>
            Clear saved people
          </Button>
        </div>
      </div>
      {/* Desktop: groups in the rail beside the ledger; phones: after it. */}
      <aside aria-label="Groups" className="flex flex-col gap-8 lg:sticky lg:top-0 lg:self-start lg:border-l lg:border-rule lg:pl-[var(--app-gutter)] lg:pt-10">
        <GroupsSection people={list} />
        <Blocked />
      </aside>
      <SettleBreakdown settle={settle} />
      <AddFriendDialog open={adding} onClose={() => setAdding(false)} />
      <PersonDialog
        person={managing}
        onClose={() => setManaging(null)}
        onRemove={(p) => setDeleting(p)}
        onBalance={managing && settle.people.get(managing.id) ? () => { const e = settle.people.get(managing.id); setManaging(null); settle.openDetail(e?.person ?? null) } : undefined}
      />
      {deleting && <DeletePeople key={deleting === 'all' ? 'all' : deleting.id} target={deleting} onClose={() => setDeleting(null)} />}
    </div>
  )
}
