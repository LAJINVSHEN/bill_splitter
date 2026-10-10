import { useId, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { FlowShell, NotSavedYet } from '@/app/FlowShell'
import { Button } from '@/components/Button'
import { Money, Notice, SectionTitle } from '@/components/Display'
import { controlClass, TextField } from '@/components/Field'
import { useMe, useQuickSplit } from '@/data/queries'
import { cn } from '@/lib/cn'
import { minorToInput, parseToMinor } from '@/lib/money'
import { allocate } from '@/lib/split'
import type { BillOut, UUID } from '@/lib/types'
import { formatPercent, percentLeft, percentToHundredths } from './assignment'
import { STEPS } from './flow'
import { FooterBar } from './parts'
import { isPercentText, normalizeMoney } from './receiptDraft'
import { CurrencyOptions, DecimalInput, MoneyInput } from './inputs'
import { PeoplePicker } from './PeoplePicker'

type Mode = 'equal' | 'percent' | 'amount'
const MODES: Array<{ mode: Mode; label: string }> = [
  { mode: 'equal', label: 'Equally' },
  { mode: 'amount', label: 'Exact' },
  { mode: 'percent', label: 'Percent' },
]

/** the shared control look, without its full width (these two share a row) */
const bare = controlClass.replace('w-full', '').replace('h-12', '')
const cellInput =
  'h-11 w-full rounded-[var(--radius-control)] border border-ink-2 bg-paper px-2.5 text-right text-[16px] font-semibold outline-none placeholder:font-medium placeholder:text-ink-2 focus:border-cobalt focus:ring-2 focus:ring-cobalt-soft'

/** Re-open a saved quick split in the mode it was made with (old "shares" become percentages). */
function initial(bill?: BillOut): { mode: Mode; percent: Record<UUID, string>; amount: Record<UUID, string> } {
  const item = bill?.items[0]
  const none = { percent: {}, amount: {} }
  if (!item || !bill) return { mode: 'equal', ...none }
  if (item.split_mode === 'custom')
    return { mode: 'amount', percent: {}, amount: Object.fromEntries(item.shares.map((s) => [s.person_id, minorToInput(s.amount_cents ?? 0, bill.currency)])) }
  if (item.split_mode !== 'weighted') return { mode: 'equal', ...none }
  const weights = item.shares.map((s) => Number(s.weight ?? '0'))
  const sum = weights.reduce((a, w) => a + w, 0) || 1
  return {
    mode: 'percent',
    amount: {},
    percent: Object.fromEntries(item.shares.map((s, i) => [s.person_id, formatPercent(Math.round(((weights[i] ?? 0) / sum) * 10000))])),
  }
}

/**
 * Split a total: amount, who, and how (equally, exact amounts, or percent). One screen.
 * Without `bill` nothing is created until "Split it" (no empty drafts); with one, it edits that bill.
 */
export function QuickForm({ bill, top }: { bill?: BillOut; top?: ReactNode }) {
  const navigate = useNavigate()
  const me = useMe()
  const split = useQuickSplit()
  const created = useRef<UUID | undefined>(bill?.id)
  const home = me.data?.default_currency ?? 'SGD'
  const [start] = useState(() => initial(bill))
  const [currency, setCurrency] = useState(bill?.currency ?? home)
  const [total, setTotal] = useState(bill?.grand_total_cents ? minorToInput(bill.grand_total_cents, bill.currency) : '')
  const [title, setTitle] = useState(bill?.title ?? '')
  const selfId = me.data?.self_person_id
  const [selected, setSelected] = useState<UUID[]>(() => bill?.participants.map((p) => p.person_id) ?? [])
  const [mode, setMode] = useState<Mode>(start.mode)
  const [percent, setPercent] = useState<Record<UUID, string>>(start.percent)
  const [amount, setAmount] = useState<Record<UUID, string>>(start.amount)
  const [touched, setTouched] = useState(false)
  const [dirty, setDirty] = useState(false)
  const pending = useRef<Promise<boolean> | null>(null)
  const exitRequested = useRef(false)
  const totalId = useId()

  // "Me" is always in: the owner paid (they can owe nothing with 0% or 0)
  const people = selfId && !selected.includes(selfId) ? [selfId, ...selected] : selected
  const minor = parseToMinor(total, currency)
  const hasTotal = minor !== null && minor > 0

  const hundredths = people.map((id) => percentToHundredths(percent[id] ?? ''))
  const pctLeft = percentLeft(people.map((id) => percent[id] ?? ''))
  const exact = people.map((id) => ((amount[id] ?? '').trim() === '' ? 0 : parseToMinor(amount[id] ?? '', currency)))
  const exactLeft = hasTotal && exact.every((v) => v !== null) ? (minor as number) - exact.reduce<number>((a, v) => a + (v ?? 0), 0) : null

  let shares: number[] | null = null
  if (hasTotal && people.length) {
    if (mode === 'equal') shares = allocate(minor as number, people.map(() => 1))
    else if (mode === 'percent' && hundredths.every((h) => h !== null) && hundredths.some((h) => (h ?? 0) > 0))
      shares = allocate(minor as number, hundredths as number[])
    else if (mode === 'amount') shares = exact.map((v) => v ?? 0)
  }
  const amountOf = (id: UUID) => shares?.[people.indexOf(id)]

  const balance: { text: ReactNode; done: boolean } | null =
    mode === 'percent' && hasTotal
      ? pctLeft === null
        ? { text: 'Use numbers with up to 2 decimals', done: false }
        : { text: pctLeft === 0 ? 'Adds up to 100%' : pctLeft > 0 ? `${formatPercent(pctLeft)}% left` : `${formatPercent(-pctLeft)}% too much`, done: pctLeft === 0 }
      : mode === 'amount' && hasTotal && exactLeft !== null
        ? {
            text:
              exactLeft === 0 ? (
                'Adds up to the total'
              ) : (
                <>
                  <Money minor={Math.abs(exactLeft)} currency={currency} code /> {exactLeft > 0 ? 'left' : 'too much'}
                </>
              ),
            done: exactLeft === 0,
          }
        : null

  const problem = !hasTotal
    ? 'Enter the total.'
    : people.length < 2
      ? 'Add who you’re splitting with.'
      : mode !== 'equal' && !balance?.done
        ? mode === 'percent'
          ? 'The percentages need to add up to 100%.'
          : 'The amounts need to add up to the total.'
        : null

  const change = () => setDirty(true)

  const submit = () => {
    if (pending.current) return
    setTouched(true)
    if (problem || minor === null) return
    setDirty(true)
    const participants =
      mode === 'percent'
        ? people.map((id, i) => ({ person_id: id, weight: formatPercent(hundredths[i] ?? 0) }))
        : mode === 'amount'
          ? people.map((id, i) => ({ person_id: id, amount_cents: exact[i] ?? 0 }))
          : people.map((id) => ({ person_id: id }))
    const request = split
      .mutateAsync({
        billId: created.current,
        currency,
        previousCurrency: bill?.currency,
        total_cents: minor,
        mode: mode === 'percent' ? 'shares' : mode === 'amount' ? 'amounts' : 'equal',
        participants,
        title: title.trim() || undefined,
        onCreated: (id) => (created.current = id),
      })
      .then((saved) => {
        setDirty(false)
        if (!exitRequested.current) navigate(`/bills/${saved.id}`, { replace: true })
        return true
      })
      .catch(() => false)
    pending.current = request
    void request.finally(() => {
      pending.current = null
      exitRequested.current = false
    })
  }

  return (
    <FlowShell
      billId={bill?.id}
      steps={STEPS.quick}
      current={0}
      exitLabel="Exit"
      save={{
        dirty,
        saving: split.isPending,
        error: split.error,
        flush: async () => {
          if (pending.current) {
            exitRequested.current = true
            return pending.current
          }
          if (dirty || split.error) throw new NotSavedYet('This split isn’t saved yet. Tap Split it to keep it.')
          return true
        },
      }}
      footer={
        <FooterBar>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[16px] font-semibold">
              <span className="hero-num mr-1 text-[24px]">{people.length}</span>
              {people.length === 1 ? 'person' : 'people'}
            </span>
            {balance && !balance.done && <span className="truncate text-[14px] font-semibold text-warn">{balance.text}</span>}
          </span>
          <Button size="lg" loading={split.isPending} onClick={submit}>
            Split it
          </Button>
        </FooterBar>
      }
    >
      <fieldset disabled={split.isPending} className="flex min-w-0 max-w-[640px] flex-col gap-6">
        {top}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={totalId} className="text-[15px] font-semibold">
            Total
          </label>
          <div className="flex gap-2">
            <select
              aria-label="Currency"
              value={currency}
              onChange={(e) => {
                change()
                setCurrency(e.target.value)
                setTotal((t) => normalizeMoney(t, e.target.value))
                setAmount((a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, normalizeMoney(v, e.target.value)])))
              }}
              className={cn(bare, 'h-14 w-[96px] shrink-0 appearance-auto pr-1 font-semibold')}
            >
              <CurrencyOptions short />
            </select>
            <MoneyInput
              id={totalId}
              currency={currency}
              value={total}
              onChange={(value) => {
                change()
                setTotal(value)
              }}
              placeholder="0"
              aria-invalid={touched && !hasTotal ? true : undefined}
              className={cn(bare, 'hero-num h-14 w-auto min-w-0 flex-1 text-[28px]')}
            />
          </div>
        </div>
        <TextField
          label="What was it?"
          value={title}
          onChange={(e) => {
            change()
            setTitle(e.target.value)
          }}
          maxLength={120}
          autoComplete="off"
        />

        <div className="flex flex-col gap-2">
          <SectionTitle>Who’s in</SectionTitle>
          <div role="radiogroup" aria-label="How to split" className="flex gap-5 border-b border-rule">
            {MODES.map((m) => (
              <button
                key={m.mode}
                type="button"
                role="radio"
                aria-checked={mode === m.mode}
                onClick={() => {
                  if (m.mode !== mode) change()
                  setMode(m.mode)
                }}
                className={cn('h-11 whitespace-nowrap text-[15px] font-semibold', mode === m.mode ? 'text-ink shadow-[inset_0_-3px_0_var(--color-cobalt)]' : 'text-ink-2 hover:text-ink')}
              >
                {m.label}
              </button>
            ))}
          </div>
          <PeoplePicker
            selected={people}
            onChange={(ids) => {
              change()
              setSelected(ids)
            }}
            known={bill?.participants.map((p) => ({ id: p.person_id, name: p.name, color_seed: p.color_seed, is_self: p.is_self }))}
            locked={selfId ? [selfId] : []}
            aside={({ id, name, is_self }) => {
              const who = is_self ? 'me' : name
              const share = amountOf(id)
              return (
                <span className="ml-auto flex shrink-0 items-center gap-3">
                  {mode === 'percent' && (
                    <span className="relative w-[5.75rem]">
                      <DecimalInput
                        aria-label={`Percent for ${who}`}
                        allow={isPercentText}
                        value={percent[id] ?? ''}
                        placeholder={pctLeft !== null && pctLeft > 0 ? formatPercent(pctLeft) : '0'}
                        onChange={(v) => {
                          change()
                          setPercent((p) => ({ ...p, [id]: v }))
                        }}
                        className={cn(cellInput, 'pr-7')}
                      />
                      <span aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-2">
                        %
                      </span>
                    </span>
                  )}
                  {mode === 'amount' ? (
                    <MoneyInput
                      aria-label={`Amount for ${who}`}
                      currency={currency}
                      value={amount[id] ?? ''}
                      placeholder={exactLeft !== null && exactLeft > 0 ? minorToInput(exactLeft, currency) : '0'}
                      onChange={(v) => {
                        change()
                        setAmount((a) => ({ ...a, [id]: v }))
                      }}
                      className={cn(cellInput, 'w-[7.5rem]')}
                    />
                  ) : (
                    <span className="min-w-[4.5rem] text-right text-[16px] font-semibold">
                      {share !== undefined ? <Money minor={share} currency={currency} /> : <span className="text-ink-2">–</span>}
                    </span>
                  )}
                </span>
              )
            }}
          />
          {balance && (
            <p aria-live="polite" className={cn('text-right text-[15px] font-semibold', balance.done ? 'text-ink-2' : 'text-warn')}>
              {balance.text}
            </p>
          )}
        </div>

        {touched && problem && <Notice tone="warn">{problem}</Notice>}
        {split.error && <Notice tone="danger">{split.error.message}</Notice>}
      </fieldset>
    </FlowShell>
  )
}
