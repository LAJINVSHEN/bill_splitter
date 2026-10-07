import { useState, type FormEvent } from 'react'
import { Button } from '@/components/Button'
import { Avatar, PageTitle } from '@/components/Display'
import { TextField } from '@/components/Field'
import { Dialog, useToast } from '@/components/Feedback'
import { useCreatePerson, usePeople, useUpdatePerson } from '@/data/queries'
import { LoadError, SectionLoader } from '@/features/home/BillList'
import { cleanName, HUES, nameError, nearestHue } from '@/features/home/people'
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

export default function PeoplePage() {
  const people = usePeople()
  const [editing, setEditing] = useState<PersonOut | null>(null)
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
          <ul aria-label="Saved people" className="border-t-[1.5px] border-ink md:max-w-[720px]">
            {list.map((p) => (
              <li key={p.id} className="flex min-h-[56px] items-center gap-3 border-b border-rule">
                <Avatar name={p.name} seed={p.color_seed} size={32} />
                <span className="min-w-0 flex-1 truncate text-base font-semibold">
                  {p.name}
                  {p.is_self && <span className="ml-2 text-[15px] font-semibold text-ink-2">You</span>}
                </span>
                <Button variant="quiet" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)}>
                  Edit
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      {editing && <EditPerson key={editing.id} person={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
