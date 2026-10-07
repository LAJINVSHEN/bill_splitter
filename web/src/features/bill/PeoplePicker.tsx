import { useId, useMemo, useState, type ReactNode } from 'react'
import { EqualsMark } from '@/components/Brand'
import { Button } from '@/components/Button'
import { Avatar, Notice } from '@/components/Display'
import { Icon } from '@/components/Icon'
import { useCreatePerson, usePeople } from '@/data/queries'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { UUID } from '@/lib/types'

export interface PickerPerson {
  id: UUID
  name: string
  color_seed: number
  is_self: boolean
}

const SHOW = 12
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * Who's splitting: "Me" first, then saved people by recency, as checkboxes with their colour.
 * Type to find someone; Enter or + adds a new person and ticks them.
 * Controlled: `selected` is ordered (Me first); rows never jump when ticked.
 */
export function PeoplePicker({
  selected,
  onChange,
  known = [],
  locked = [],
  note,
  aside,
}: {
  selected: UUID[]
  onChange: (ids: UUID[]) => void
  /** people already on the bill (kept even if archived since) */
  known?: PickerPerson[]
  /** can't be unticked (the owner's "Me") */
  locked?: UUID[]
  /** short fact at the end of a row, e.g. "paid" */
  note?: (id: UUID) => ReactNode
  /** controls for a ticked row (shares steppers, amounts) */
  aside?: (person: PickerPerson) => ReactNode
}) {
  const people = usePeople()
  const create = useCreatePerson()
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(false)
  const inputId = useId()
  // rows keep their place: Me, whoever was ticked when we arrived (and anyone added here), then the rest
  const [pinned, setPinned] = useState<UUID[]>(selected)

  const all = useMemo(() => {
    const list: PickerPerson[] = (people.data ?? []).map((p) => ({ id: p.id, name: p.name, color_seed: p.color_seed, is_self: p.is_self }))
    for (const k of known) if (!list.some((p) => p.id === k.id)) list.push(k)
    const pin = pinned
    const rank = (p: PickerPerson) => (p.is_self ? -1 : pin.includes(p.id) ? pin.indexOf(p.id) : pin.length + list.indexOf(p))
    return [...list].sort((a, b) => rank(a) - rank(b))
  }, [people.data, known, pinned])

  const q = norm(query)
  const matches = q ? all.filter((p) => norm(p.name).includes(q)) : all
  const exact = q ? all.find((p) => norm(p.name) === q) : undefined
  const visible = q || expanded ? matches : matches.slice(0, Math.max(SHOW, pinned.length + 1))
  const hidden = matches.length - visible.length

  const toggle = (id: UUID, on: boolean) => {
    if (locked.includes(id)) return
    onChange(on ? [...selected.filter((s) => s !== id), id] : selected.filter((s) => s !== id))
  }

  const addOrPick = async () => {
    const name = query.trim().replace(/\s+/g, ' ')
    if (!name) return
    if (exact) {
      if (!selected.includes(exact.id)) toggle(exact.id, true)
      setQuery('')
      return
    }
    try {
      const p = await create.mutateAsync({ name })
      setPinned((list) => [...list, p.id])
      onChange([...selected, p.id])
      setQuery('')
    } catch {
      /* shown below */
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void addOrPick()
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Add or find someone
        </label>
        <input
          id={inputId}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            create.reset()
          }}
          placeholder="Add or find someone"
          autoComplete="off"
          enterKeyHint="done"
          maxLength={60}
          className="h-12 min-w-0 flex-1 rounded-[var(--radius-control)] border-[1.5px] border-ink bg-paper px-3.5 text-[17px] font-medium text-ink outline-none placeholder:text-ink-2 focus:border-cobalt focus:ring-2 focus:ring-cobalt-soft"
        />
        <button
          type="submit"
          aria-label={exact ? `Add ${exact.name}` : query.trim() ? `Add ${query.trim()} as a new person` : 'Add person'}
          disabled={!query.trim() || create.isPending}
          aria-busy={create.isPending || undefined}
          className="grid h-12 w-12 shrink-0 place-items-center rounded-[var(--radius-control)] bg-ink text-white disabled:bg-mist-2 disabled:text-ink-2"
        >
          {create.isPending ? <EqualsMark size="sm" moving tone="white" /> : <Icon name="plus" />}
        </button>
      </form>

      {create.error && (
        <p role="alert" className="text-[15px] font-semibold text-danger">
          {create.error instanceof ApiError ? create.error.message : 'Couldn’t add them. Try again.'}
        </p>
      )}
      {people.error && !people.data && (
        <Notice tone="danger" action={<Button variant="quiet" className="-my-2.5" onClick={() => void people.refetch()}>Retry</Button>}>
          Couldn’t load your people.
        </Notice>
      )}

      <ul aria-label="People" aria-busy={people.isPending || undefined}>
        {q && !exact && (
          <li className="border-b border-rule">
            <button type="button" onClick={() => void addOrPick()} disabled={create.isPending} className="flex min-h-[52px] w-full items-center gap-3 text-left text-[16px] font-semibold text-cobalt">
              <span className="grid h-[22px] w-[22px] place-items-center">
                <Icon name="plus" size={20} />
              </span>
              Add “{query.trim()}”
            </button>
          </li>
        )}
        {visible.map((p) => {
          const on = selected.includes(p.id)
          const isLocked = locked.includes(p.id)
          return (
            <li key={p.id} className="flex min-h-[52px] flex-wrap items-center gap-x-3 border-b border-rule pb-px">
              <label className={cn('flex min-h-[52px] min-w-[min(100%,11rem)] flex-1 items-center gap-3', isLocked ? 'cursor-default' : 'cursor-pointer')}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={isLocked}
                  onChange={(e) => toggle(p.id, e.target.checked)}
                  className="h-[22px] w-[22px] shrink-0 accent-cobalt disabled:opacity-100"
                />
                <Avatar name={p.name} seed={p.color_seed} />
                <span className={cn('min-w-0 flex-1 truncate text-[16px]', on ? 'font-semibold' : 'font-medium')}>{p.is_self ? 'Me' : p.name}</span>
                {note && <span className="shrink-0 text-[14px] font-semibold text-ink-2">{note(p.id)}</span>}
              </label>
              {on && aside?.(p)}
            </li>
          )
        })}
        {people.isPending && (
          <li className="flex min-h-[52px] items-center border-b border-rule" aria-label="Loading people">
            <span className="h-3 w-40 rounded bg-mist-2" />
          </li>
        )}
      </ul>
      {hidden > 0 && (
        <Button variant="quiet" className="self-start" onClick={() => setExpanded(true)}>
          Show {hidden} more
        </Button>
      )}
    </div>
  )
}
