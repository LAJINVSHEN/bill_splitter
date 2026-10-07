import { useState, type ReactNode } from 'react'
import { Button } from '@/components/Button'
import { Avatar, Money } from '@/components/Display'
import { Dialog } from '@/components/Feedback'
import { cn } from '@/lib/cn'
import { minorToInput, parseToMinor } from '@/lib/money'
import { allocate } from '@/lib/split'
import type { ItemOut, ParticipantOut, UUID } from '@/lib/types'
import {
  dialogIncluded,
  dialogToAssign,
  formatPercent,
  initialDialog,
  percentLeft,
  percentToHundredths,
  shareWithEveryone,
  switchMode,
  type Assign,
  type DialogMode,
  type DialogState,
} from './assignment'
import { DecimalInput, MoneyInput, Stepper } from './inputs'
import { isPercentText } from './receiptDraft'

const MODES: Array<{ mode: DialogMode; label: string }> = [
  { mode: 'equal', label: 'Equally' },
  { mode: 'shares', label: 'Shares' },
  { mode: 'percent', label: 'Percent' },
  { mode: 'exact', label: 'Exact' },
]

/** What each person would pay for this item in the dialog's current mode (null = not on it). */
function preview(state: DialogState, total: number, ids: UUID[]): Map<UUID, number> {
  const on = dialogIncluded(state, ids)
  const out = new Map<UUID, number>()
  if (state.mode === 'exact') {
    on.forEach((id) => out.set(id, state.exact[id] ?? 0))
    return out
  }
  const weights = on.map((id) =>
    state.mode === 'shares' ? (state.shares[id] ?? 0) : state.mode === 'percent' ? (percentToHundredths(state.percent[id] ?? '') ?? 0) : 1,
  )
  if (!on.length || weights.every((w) => w === 0)) return out
  allocate(total, weights).forEach((v, i) => out.set(on[i] as UUID, v))
  return out
}

/**
 * Split one item another way: equally between some people, by shares, by percentages (must make
 * 100), or exact amounts (must make the item's price; the difference shows as you type).
 */
export function SplitDialog({
  item,
  participants,
  currency,
  onClose,
  onSave,
}: {
  item: ItemOut | null
  participants: ParticipantOut[]
  currency: string
  onClose: () => void
  onSave: (a: Assign) => void
}) {
  return (
    <Dialog open={Boolean(item)} onClose={onClose} title={item?.name ?? 'Split'}>
      {item && <SplitBody key={item.id} item={item} participants={participants} currency={currency} onClose={onClose} onSave={onSave} />}
    </Dialog>
  )
}

function SplitBody({
  item,
  participants,
  currency,
  onClose,
  onSave,
}: {
  item: ItemOut
  participants: ParticipantOut[]
  currency: string
  onClose: () => void
  onSave: (a: Assign) => void
}) {
  const ids = participants.map((p) => p.person_id)
  const total = item.total_price_cents
  const toText = (minor: number) => (minor ? minorToInput(minor, currency) : '')
  const [state, setState] = useState<DialogState>(() => initialDialog(item, ids))
  // exact amounts as typed (strings), seeded from the state's minor units
  const [exactText, setExactText] = useState<Record<UUID, string>>(() => Object.fromEntries(ids.map((id) => [id, toText(state.exact[id] ?? 0)])))

  const check = dialogToAssign(state, total, ids)
  const amounts = preview(state, total, ids)
  const exactSum = ids.reduce((a, id) => a + (state.exact[id] ?? 0), 0)
  const left = state.mode === 'percent' ? percentLeft(ids.map((id) => state.percent[id] ?? '')) : null

  const setMode = (mode: DialogMode) => {
    const next = switchMode(state, mode, total, ids)
    setState(next)
    if (mode === 'exact' && state.mode !== 'exact') setExactText(Object.fromEntries(ids.map((id) => [id, toText(next.exact[id] ?? 0)])))
  }

  let status: { text: ReactNode; tone: 'ok' | 'warn' } | null = null
  if (state.mode === 'exact') {
    const diff = total - exactSum
    status =
      diff === 0
        ? { text: 'Adds up to the price', tone: 'ok' }
        : { text: <>{diff > 0 ? 'Left to give' : 'Too much by'} <Money minor={Math.abs(diff)} currency={currency} code /></>, tone: 'warn' }
  } else if (state.mode === 'percent') {
    status =
      left === null
        ? { text: 'Use numbers with up to 2 decimals', tone: 'warn' }
        : left === 0
          ? { text: 'Adds up to 100%', tone: 'ok' }
          : { text: left > 0 ? `${formatPercent(left)}% left to give` : `${formatPercent(-left)}% too much`, tone: 'warn' }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[16px] font-semibold">
          <Money minor={total} currency={currency} code />
        </span>
        <Button variant="quiet" onClick={() => onSave(shareWithEveryone(ids))}>
          Share with everyone
        </Button>
      </div>

      <div role="radiogroup" aria-label="How to split this item" className="flex gap-4 border-b border-rule">
        {MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            role="radio"
            aria-checked={state.mode === m.mode}
            onClick={() => setMode(m.mode)}
            className={cn('h-11 text-[15px] font-semibold', state.mode === m.mode ? 'text-ink shadow-[inset_0_-3px_0_var(--color-cobalt)]' : 'text-ink-2 hover:text-ink')}
          >
            {m.label}
          </button>
        ))}
      </div>

      <ul aria-label="People" className="-mt-1">
        {participants.map((p) => {
          const id = p.person_id
          const amount = amounts.get(id)
          const name = p.is_self ? 'Me' : p.name
          return (
            <li key={id} className="flex min-h-[52px] items-center gap-3 border-b border-rule">
              {state.mode === 'equal' ? (
                <label className="flex min-h-[52px] min-w-0 flex-1 cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={state.included.includes(id)}
                    onChange={(e) =>
                      setState((s) => ({ ...s, included: e.target.checked ? [...s.included, id] : s.included.filter((x) => x !== id) }))
                    }
                    className="h-[22px] w-[22px] shrink-0 accent-cobalt"
                  />
                  <Avatar name={p.name} seed={p.color_seed} />
                  <span className="min-w-0 flex-1 truncate text-[16px] font-semibold">{name}</span>
                </label>
              ) : (
                <span className="flex min-w-0 flex-1 items-center gap-3">
                  <Avatar name={p.name} seed={p.color_seed} />
                  <span className="min-w-0 flex-1 truncate text-[16px] font-semibold">{name}</span>
                </span>
              )}
              {state.mode === 'shares' && (
                <Stepper value={state.shares[id] ?? 0} label={name} onChange={(n) => setState((s) => ({ ...s, shares: { ...s.shares, [id]: n } }))} />
              )}
              {state.mode === 'percent' && (
                <span className="relative w-[5.5rem] shrink-0">
                  <DecimalInput
                    aria-label={`Percent for ${name}`}
                    allow={isPercentText}
                    value={state.percent[id] ?? ''}
                    onChange={(v) => setState((s) => ({ ...s, percent: { ...s.percent, [id]: v } }))}
                    className="h-11 w-full rounded-[var(--radius-control)] border-[1.5px] border-ink bg-paper pl-2 pr-7 text-right text-[16px] font-semibold outline-none focus:border-cobalt focus:ring-2 focus:ring-cobalt-soft"
                  />
                  <span aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-2">
                    %
                  </span>
                </span>
              )}
              {state.mode === 'exact' ? (
                <MoneyInput
                  aria-label={`Amount for ${name}`}
                  currency={currency}
                  value={exactText[id] ?? ''}
                  placeholder="0"
                  onChange={(v) => {
                    setExactText((t) => ({ ...t, [id]: v }))
                    setState((s) => ({ ...s, exact: { ...s.exact, [id]: v.trim() ? (parseToMinor(v, currency) ?? 0) : 0 } }))
                  }}
                  className="h-11 w-[7.5rem] shrink-0 rounded-[var(--radius-control)] border-[1.5px] border-ink bg-paper px-2.5 text-right text-[16px] font-semibold outline-none focus:border-cobalt focus:ring-2 focus:ring-cobalt-soft"
                />
              ) : (
                <span className="w-[4.75rem] shrink-0 text-right text-[16px] font-semibold">
                  {amount !== undefined ? <Money minor={amount} currency={currency} /> : <span className="text-ink-2">–</span>}
                </span>
              )}
            </li>
          )
        })}
      </ul>

      <p aria-live="polite" className={cn('min-h-6 text-[15px] font-semibold', status?.tone === 'warn' ? 'text-warn' : 'text-ink')}>
        {status?.text}
        {!status && !check.ok && <span className="text-warn">{check.reason}</span>}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <Button variant="danger" onClick={() => onSave({ mode: null, shares: [] })}>
          Clear
        </Button>
        <div className="flex gap-2.5">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!check.ok} onClick={() => check.ok && onSave(check.assign)}>
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}
