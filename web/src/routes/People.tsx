import { useState, type FormEvent } from 'react'
import { Button } from '@/components/Button'
import { Avatar, EvenBadge, Money, Notice, PageTitle } from '@/components/Display'
import { TextField } from '@/components/Field'
import { Dialog, useToast } from '@/components/Feedback'
import { Icon } from '@/components/Icon'
import { useClearBills, useClearPeople, useCreatePerson, useDeletePerson, usePeople, useSummary, useUpdatePerson } from '@/data/queries'
import { LoadError, SectionLoader } from '@/features/home/BillList'
import { cleanName, HUES, nameError, nearestHue } from '@/features/home/people'
import { ApiError } from '@/lib/api'
import type { PersonOut, SummaryOut } from '@/lib/types'

/** The hue fewest people already have, so new people look different from the last few. */
function freshHue(people: PersonOut[]): number {
  const used = new Map<number, number>(HUES.map((h) => [h.hue, 0]))
  for (const p of people) {
    const h = nearestHue(p.color_seed)
    used.set(h, (used.get(h) ?? 0) + 1)
  }
  return [...used.entries()].sort((a, b) => a[1] - b[1])[0]?.[0] ?? 200
}

function HuePicker({ name, value, onChange }: { name: string; value: number; onChange: (hue: number) => void }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-[15px] font-semibold">Colour</legend>
      <div className="grid w-fit grid-cols-4 gap-x-3 gap-y-1 min-[420px]:grid-cols-8 min-[420px]:gap-x-1">
        {HUES.map((h) => (
          <label
            key={h.hue}
            className="grid h-11 w-11 cursor-pointer place-items-center rounded-full has-[:checked]:ring-2 has-[:checked]:ring-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-cobalt"
          >
            <input type="radio" name="hue" className="sr-only" checked={value === h.hue} onChange={() => onChange(h.hue)} />
            <Avatar name={name || '?'} seed={h.hue} size={36} />
            <span className="sr-only">{h.name}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function EditPerson({ person, onClose }: { person: PersonOut; onClose: () => void }) {
  const update = useUpdatePerson()
  const toast = useToast()
  const [name, setName] = useState(person.name)
  const [hue, setHue] = useState(nearestHue(person.color_seed))
  const [error, setError] = useState<string | null>(null)
  const [confirmArchive, setConfirmArchive] = useState(false)

  async function save(e?: FormEvent) {
    e?.preventDefault()
    const clean = cleanName(name)
    const problem = nameError(clean)
    if (problem) return setError(problem)
    const body: { id: string; name?: string; color_seed?: number } = { id: person.id }
    if (clean !== person.name) body.name = clean
    if (hue !== nearestHue(person.color_seed)) body.color_seed = hue
    if (!body.name && body.color_seed === undefined) return onClose()
    try {
      await update.mutateAsync(body)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save. Try again.')
    }
  }

  async function archive() {
    try {
      await update.mutateAsync({ id: person.id, archived: true })
      toast(`${person.name} archived`)
      onClose()
    } catch (err) {
      setConfirmArchive(false)
      setError(err instanceof ApiError ? err.message : 'Couldn’t archive. Try again.')
    }
  }

  if (confirmArchive) {
    return (
      <Dialog
        open
        onClose={() => setConfirmArchive(false)}
        title={`Archive ${person.name}?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmArchive(false)}>
              Cancel
            </Button>
            <Button variant="danger" className="px-4" loading={update.isPending} onClick={() => void archive()}>
              Archive
            </Button>
          </>
        }
      >
        <p className="text-[17px]">Old bills keep the name.</p>
      </Dialog>
    )
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={person.is_self ? 'You' : 'Edit person'}
      footer={
        <>
          {!person.is_self && (
            <Button variant="danger" className="mr-auto" onClick={() => setConfirmArchive(true)}>
              Archive
            </Button>
          )}
          <Button type="submit" form="edit-person" loading={update.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="edit-person" onSubmit={(e) => void save(e)} noValidate className="flex flex-col gap-5">
        <TextField
          label="Name"
          value={name}
          maxLength={60}
          autoComplete="off"
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          error={error}
        />
        <HuePicker name={name} value={hue} onChange={setHue} />
      </form>
    </Dialog>
  )
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
      <Button type="submit" loading={create.isPending}>
        Add
      </Button>
    </form>
  )
}

function DeletePeople({ target, onClose }: { target: PersonOut | 'all'; onClose: () => void }) {
  const remove = useDeletePerson()
  const clear = useClearPeople()
  const clearBills = useClearBills()
  const update = useUpdatePerson()
  const toast = useToast()
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [deletingBills, setDeletingBills] = useState(false)
  const all = target === 'all'
  const phrase = deletingBills ? (all ? 'DELETE ALL BILLS' : 'DELETE ASSOCIATED BILLS') : 'DELETE ALL PEOPLE'
  const busy = remove.isPending || clear.isPending || clearBills.isPending || update.isPending

  async function deletePeople() {
    if (busy || ((all || deletingBills) && confirmation !== phrase)) return
    setError(null)
    try {
      if (deletingBills) {
        await clearBills.mutateAsync({ personId: all ? undefined : target.id, permanent: true })
        toast(all ? 'Bill history cleared' : 'Associated bill history deleted')
      }
      if (all) await clear.mutateAsync({ permanent: true })
      else await remove.mutateAsync(target.id)
      toast(all ? 'Saved people deleted' : `${target.name} deleted`)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete. Try again.')
      setConflict(err instanceof ApiError && err.code === 'person_referenced')
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

  return (
    <Dialog open onClose={() => { if (!busy) onClose() }}
      title={deletingBills ? 'Delete bill history first?' : all ? 'Delete all saved people?' : 'Delete saved person?'}
      footer={<>
        <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button variant="danger" icon={<Icon name="trash" size={20} />} loading={remove.isPending || clear.isPending || clearBills.isPending}
          disabled={busy || ((all || deletingBills) && confirmation !== phrase)} onClick={() => void deletePeople()}>
          {deletingBills ? 'Delete bills & people' : all ? 'Delete all people' : 'Delete person'}
        </Button>
      </>}>
      <div className="flex flex-col gap-4" aria-busy={busy}>
        {!all && <p className="break-words font-semibold">{target.name}</p>}
        {deletingBills ? <>
          <p>{all ? 'Every bill, draft and previously deleted bill across all pages will be permanently erased.' : 'Every bill that uses this person, including previously deleted bills, will be permanently erased for all its participants.'}</p>
          <p>Items, splits and payment history cannot be recovered. Share links stop working, scans are cancelled, and photos are queued for deletion. Scan usage still counts toward your quota.</p>
          <p>{all ? 'Then all saved people, including archived people, will be deleted. Me stays.' : 'Then this saved person will be deleted.'}</p>
        </> : <>
          <p>{all ? 'All saved people, including archived people, will be permanently deleted. Me stays.' : 'This saved person will be permanently deleted.'} This cannot be undone.</p>
          <p>People used by bills cannot be deleted while that history remains.</p>
        </>}
        {(all || deletingBills) && <TextField label={`Type ${phrase} to confirm`} value={confirmation} disabled={busy} autoComplete="off" onChange={(event) => setConfirmation(event.target.value)} />}
        {error && <Notice tone="danger">{error}</Notice>}
        {conflict && !deletingBills && <Button variant="secondary" disabled={busy} icon={<Icon name="trash" size={20} />}
          onClick={() => { setDeletingBills(true); setConfirmation(''); setError(null) }}>
          {all ? 'Delete all bill history first' : 'Delete associated bills first'}
        </Button>}
        {!deletingBills && <Button variant="quiet" loading={update.isPending || (clear.isPending && clear.variables?.permanent === false)} disabled={busy} onClick={() => void archive()}>
          {all ? 'Archive people instead' : 'Archive instead'}
        </Button>}
      </div>
    </Dialog>
  )
}

type Balance = SummaryOut['people'][number]

/** Open balances with one person, one line per currency (never summed across currencies). */
function PersonBalance({ balances }: { balances: Balance[] | undefined }) {
  const open = (balances ?? []).filter((b) => b.they_owe_me_cents > 0 || b.i_owe_them_cents > 0)
  if (open.length === 0) return <EvenBadge />
  return (
    <span className="flex flex-col text-[15px]">
      {open.map((b) => (
        <span key={b.currency} className="whitespace-nowrap">
          {b.they_owe_me_cents > 0 ? (
            <>owes you <Money minor={b.they_owe_me_cents} currency={b.currency} code className="font-bold" /></>
          ) : (
            <>you owe <Money minor={b.i_owe_them_cents} currency={b.currency} code className="font-bold" /></>
          )}
        </span>
      ))}
    </span>
  )
}

export default function PeoplePage() {
  const people = usePeople()
  const summary = useSummary()
  const balances = new Map<string, Balance[]>()
  for (const b of summary.data?.people ?? []) balances.set(b.person_id, [...(balances.get(b.person_id) ?? []), b])
  const [editing, setEditing] = useState<PersonOut | null>(null)
  const [deleting, setDeleting] = useState<PersonOut | 'all' | null>(null)
  const list = people.data ?? []

  return (
    <div className="flex flex-col gap-6">
      <PageTitle>People</PageTitle>
      {people.isPending ? (
        <SectionLoader label="Loading people" />
      ) : people.isError ? (
        <LoadError what="people" onRetry={() => void people.refetch()} retrying={people.isFetching} />
      ) : (
        <>
          <AddPerson people={list} />
          <ul aria-label="Saved people" className="border-t-[1.5px] border-ink">
            <li aria-hidden="true" className="hidden grid-cols-[32px_minmax(160px,22rem)_minmax(0,1fr)_140px] items-center gap-3 border-b border-rule py-2.5 text-[14px] font-semibold text-ink-2 md:grid">
              <span />
              <span>Name</span>
              <span>Balance</span>
              <span />
            </li>
            {list.map((p) => (
              <li key={p.id} className="group grid min-h-[56px] grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-rule py-1.5 hover:bg-mist md:grid-cols-[32px_minmax(160px,22rem)_minmax(0,1fr)_140px]">
                <Avatar name={p.name} seed={p.color_seed} size={32} />
                <span className="min-w-0">
                  <span className="block truncate text-base font-semibold">
                    {p.name}
                    {p.is_self && <span className="ml-2 text-[15px] font-semibold text-ink-2">You</span>}
                  </span>
                  {!p.is_self && <span className="block md:hidden"><PersonBalance balances={balances.get(p.id)} /></span>}
                </span>
                <span className="hidden min-w-0 md:block">{!p.is_self && <PersonBalance balances={balances.get(p.id)} />}</span>
                {/* Desktop: revealed on row hover/focus in reserved width (nothing shifts); always shown on touch. */}
                <span className="flex items-center justify-end md:opacity-0 md:transition-opacity md:group-focus-within:opacity-100 md:group-hover:opacity-100 pointer-coarse:opacity-100">
                  <Button variant="quiet" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)}>
                    Edit
                  </Button>
                  {!p.is_self ? (
                    <Button variant="quiet" className="h-11 w-11 shrink-0 p-0 text-danger" aria-label={`Delete ${p.name}`} title={`Delete ${p.name}`} onClick={() => setDeleting(p)}>
                      <Icon name="trash" size={20} />
                    </Button>
                  ) : (
                    <span className="w-11 shrink-0" />
                  )}
                </span>
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
      {editing && <EditPerson key={editing.id} person={editing} onClose={() => setEditing(null)} />}
      {deleting && <DeletePeople key={deleting === 'all' ? 'all' : deleting.id} target={deleting} onClose={() => setDeleting(null)} />}
    </div>
  )
}
