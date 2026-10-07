import { useId, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { FlowShell } from '@/app/FlowShell'
import { Button } from '@/components/Button'
import { Money, Notice, SectionTitle } from '@/components/Display'
import { controlClass, TextField } from '@/components/Field'
import { useMe, useQuickSplit } from '@/data/queries'
import { cn } from '@/lib/cn'
import { minorToInput, parseToMinor } from '@/lib/money'
import { allocate } from '@/lib/split'
import type { BillOut, UUID } from '@/lib/types'
import { STEPS } from './flow'
import { FooterBar } from './parts'
import { normalizeMoney } from './receiptDraft'
import { CurrencyOptions, MoneyInput, Stepper } from './inputs'
import { PeoplePicker } from './PeoplePicker'

type Mode = 'equal' | 'shares'

/** the shared control look, without its full width (these two share a row) */
const bare = controlClass.replace('w-full', '').replace('h-12', '')

function initialWeights(bill?: BillOut): Record<UUID, number> {
  const item = bill?.items[0]
  if (!item || item.split_mode !== 'weighted') return {}
  return Object.fromEntries(item.shares.map((s) => [s.person_id, Math.max(0, Math.round(Number(s.weight ?? '1')))]))
}

/**
 * Split a total: amount, who, equally or by shares. One screen.
 * Without `bill` nothing is created until "Split it" (no empty drafts); with one, it edits that bill.
 */
export function QuickForm({ bill, top }: { bill?: BillOut; top?: ReactNode }) {
  const navigate = useNavigate()
  const me = useMe()
  const split = useQuickSplit()
  const created = useRef<UUID | undefined>(bill?.id)
  const home = me.data?.default_currency ?? 'SGD'
  const [currency, setCurrency] = useState(bill?.currency ?? home)
  const [total, setTotal] = useState(bill?.grand_total_cents ? minorToInput(bill.grand_total_cents, bill.currency) : '')
  const [title, setTitle] = useState(bill?.title ?? '')
  const selfId = me.data?.self_person_id
  const [selected, setSelected] = useState<UUID[]>(() => bill?.participants.map((p) => p.person_id) ?? [])
  const [mode, setMode] = useState<Mode>(bill?.items[0]?.split_mode === 'weighted' ? 'shares' : 'equal')
  const [weights, setWeights] = useState<Record<UUID, number>>(() => initialWeights(bill))
  const [touched, setTouched] = useState(false)
  const [dirty, setDirty] = useState(false)
  const pending = useRef<Promise<boolean> | null>(null)
  const exitRequested = useRef(false)
  const totalId = useId()

  // "Me" is always in: the owner paid (they can owe nothing with 0 shares)
  const people = selfId && !selected.includes(selfId) ? [selfId, ...selected] : selected
  const minor = parseToMinor(total, currency)
  const weightOf = (id: UUID) => (mode === 'equal' ? 1 : (weights[id] ?? 1))
  const sumWeights = people.reduce((a, id) => a + weightOf(id), 0)
  const amounts = minor && minor > 0 && sumWeights > 0 ? allocate(minor, people.map(weightOf)) : null
  const amountOf = (id: UUID) => amounts?.[people.indexOf(id)]

  const problem =
    minor === null || minor <= 0 ? 'Enter the total.' : people.length < 2 ? 'Add who you’re splitting with.' : sumWeights <= 0 ? 'Give someone a share.' : null

  const submit = () => {
    if (pending.current) return
    setTouched(true)
    if (problem || minor === null) return
    setDirty(true)
    const request = split.mutateAsync(
      {
        billId: created.current,
        currency,
        previousCurrency: bill?.currency,
        total_cents: minor,
        mode,
        participants: people.map((id) => (mode === 'shares' ? { person_id: id, weight: String(weightOf(id)) } : { person_id: id })),
        title: title.trim() || undefined,
        onCreated: (id) => (created.current = id),
      },
    ).then((saved) => {
      setDirty(false)
      if (!exitRequested.current) navigate(`/bills/${saved.id}`, { replace: true })
      return true
    }).catch(() => false)
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
          if (dirty || split.error) throw new Error('Use Split it to save your changes.')
          return true
        },
      }}
      footer={
        <FooterBar>
          <span className="flex-1 text-[16px] font-semibold">
            <span className="hero-num mr-1 text-[24px]">{people.length}</span>
            {people.length === 1 ? 'person' : 'people'}
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
                setDirty(true)
                setCurrency(e.target.value)
                setTotal((t) => normalizeMoney(t, e.target.value))
              }}
              className={cn(bare, 'h-14 w-[96px] shrink-0 appearance-auto pr-1 font-semibold')}
            >
              <CurrencyOptions short />
            </select>
            <MoneyInput
              id={totalId}
              currency={currency}
              value={total}
              onChange={(value) => { setDirty(true); setTotal(value) }}
              placeholder="0"
              aria-invalid={touched && (minor === null || minor <= 0) ? true : undefined}
              className={cn(bare, 'hero-num h-14 w-auto min-w-0 flex-1 text-[28px]')}
            />
          </div>
        </div>
        <TextField label="What was it?" value={title} onChange={(e) => { setDirty(true); setTitle(e.target.value) }} maxLength={120} autoComplete="off" />

        <div className="flex flex-col gap-2">
          <SectionTitle
            action={
              <div role="radiogroup" aria-label="How to split" className="flex gap-4">
                {(['equal', 'shares'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    onClick={() => { if (m !== mode) setDirty(true); setMode(m) }}
                    className={cn('h-11 text-[15px] font-semibold', mode === m ? 'text-ink shadow-[inset_0_-3px_0_var(--color-cobalt)]' : 'text-ink-2 hover:text-ink')}
                  >
                    {m === 'equal' ? 'Equally' : 'By shares'}
                  </button>
                ))}
              </div>
            }
          >
            Who’s in
          </SectionTitle>
          <PeoplePicker
            selected={people}
            onChange={(ids) => { setDirty(true); setSelected(ids) }}
            known={bill?.participants.map((p) => ({ id: p.person_id, name: p.name, color_seed: p.color_seed, is_self: p.is_self }))}
            locked={selfId ? [selfId] : []}
            aside={({ id, name, is_self }) => (
              <span className="ml-auto flex shrink-0 items-center gap-3">
                {mode === 'shares' && <Stepper value={weightOf(id)} onChange={(n) => { setDirty(true); setWeights((w) => ({ ...w, [id]: n })) }} label={is_self ? 'me' : name} />}
                <span className="min-w-[4.5rem] text-right text-[16px] font-semibold">
                  {amountOf(id) !== undefined ? <Money minor={amountOf(id) as number} currency={currency} /> : <span className="text-ink-2">–</span>}
                </span>
              </span>
            )}
          />
        </div>

        {touched && problem && <Notice tone="warn">{problem}</Notice>}
        {split.error && <Notice tone="danger">{split.error.message}</Notice>}
      </fieldset>
    </FlowShell>
  )
}
