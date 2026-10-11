import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Avatar, EvenBadge, HeroAmount, Money } from '@/components/Display'
import { Dialog, useToast } from '@/components/Feedback'
import { Icon } from '@/components/Icon'
import { PaidToggle } from '@/components/PaidToggle'
import { useRecordSettleUp, useSettleUp, useUndoSettleUp, type SettleRecord } from '@/data/queries'
import { shortDate } from '@/features/home/format'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/money'
import type { SettleDebt, SettlePayment, SettlePerson, SettlePiece, SettleView } from '@/lib/types'
import { breakdown, byPerson, payLine, paymentsOf, planNote, shortNames, who, type PersonSettle } from './logic'

/** A row marked paid in this visit: kept on screen (toggled on) so a mis-tap is one tap to undo. */
interface Done {
  key: string
  currency: string
  payment?: SettlePayment // absent for a loop that was cleared
  people: SettlePerson[] // whose breakdown shows it
  combine: string | null
  pieces: SettlePiece[]
}

const payKey = (view: SettleView, currency: string, p: SettlePayment) =>
  `${view}|${currency}|${p.from_person.person_id}|${p.to_person.person_id}|${p.amount_cents}`

/**
 * Balances on People, from the cross-bill plan. "Simplified" is the fewest payments that leave
 * everyone even (following chains of debts, so each one marks real bill debts paid); "Original"
 * is who owes whom as the bills say. Currencies stay apart unless merged with saved rates.
 */
export function useSettle(homeCurrency: string) {
  const [view, setView] = useState<SettleView>('simplified')
  const [merge, setMerge] = useState(false)
  const [detail, setDetail] = useState<SettlePerson | null>(null)
  const [done, setDone] = useState<Done[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const q = useSettleUp(merge ? homeCurrency : null)
  const record = useRecordSettleUp()
  const undo = useUndoSettleUp()
  const toast = useToast()
  const people = useMemo(() => byPerson(q.data, view), [q.data, view])
  const names = useMemo(() => shortNames(q.data), [q.data])
  const combine = q.data?.combined_into ?? null

  async function run(key: string, work: () => Promise<void>) {
    if (busy) return
    setBusy(key)
    try {
      await work()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t save. Try again.')
    } finally {
      setBusy(null)
    }
  }
  async function mark(body: Omit<SettleRecord, 'combine'>, row: Omit<Done, 'pieces' | 'combine'>) {
    await run(row.key, async () => {
      const out = await record.mutateAsync({ ...body, combine })
      setDone((d) => [...d, { ...row, combine, pieces: out.applied ?? [] }])
    })
  }
  async function unmark(row: Done) {
    await run(row.key, async () => {
      await undo.mutateAsync({ combine: row.combine, pieces: row.pieces })
      setDone((d) => d.filter((x) => x.key !== row.key))
    })
  }

  return {
    view, setView, merge, setMerge, homeCurrency, missingRates: merge ? (q.data?.missing_rates ?? []) : [],
    data: q.data, loaded: q.isSuccess, people, names, note: planNote(q.data, view),
    detail, openDetail: setDetail, closeDetail: () => { setDetail(null); setDone([]) },
    done, busy,
    markPaid: (p: SettlePayment, currency: string) =>
      void mark({ view, currency, from_person_id: p.from_person.person_id, to_person_id: p.to_person.person_id, amount_cents: p.amount_cents },
        { key: payKey(view, currency, p), currency, payment: p, people: [p.from_person, p.to_person] }),
    clearLoop: (currency: string, people: SettlePerson[]) =>
      void mark({ view: 'cancel_out', currency }, { key: `loop|${currency}`, currency, people }),
    unmark: (row: Done) => void unmark(row),
    payKey: (p: SettlePayment, currency: string) => payKey(view, currency, p),
  }
}
export type Settle = ReturnType<typeof useSettle>

const VIEWS: Array<{ value: SettleView; label: string }> = [
  { value: 'simplified', label: 'Simplified' },
  { value: 'original', label: 'Original' },
]

/** Page-title controls: the view switch, and merging currencies when there's more than one. */
export function SettleControls({ settle }: { settle: Settle }) {
  if (!settle.note) return null
  return (
    <>
      {(settle.data?.currencies.length ?? 0) > 1 && (
        <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-[15px] font-semibold">
          <input type="checkbox" className="h-5 w-5 accent-[var(--color-cobalt)]" checked={settle.merge} onChange={(e) => settle.setMerge(e.target.checked)} />
          All in {settle.homeCurrency}
        </label>
      )}
      <div role="group" aria-label="Balances" className="inline-flex shrink-0 rounded-[var(--radius-control)] border-[1.5px] border-ink p-0.5">
        {VIEWS.map((v) => (
          <button
            key={v.value}
            type="button"
            aria-pressed={settle.view === v.value}
            onClick={() => settle.setView(v.value)}
            className={cn('h-9 rounded-[4px] px-3 text-[15px] font-semibold transition-colors', settle.view === v.value ? 'bg-ink text-white' : 'text-ink hover:bg-mist')}
          >
            {v.label}
          </button>
        ))}
      </div>
    </>
  )
}

/** "All in SGD" without a saved rate: say which one, and where to add it. */
export function MissingRates({ settle }: { settle: Settle }) {
  const missing = settle.missingRates
  if (missing.length === 0) return null
  return (
    <p className="flex items-start gap-2 text-[15px] font-semibold text-warn">
      <Icon name="alert" className="mt-px shrink-0" />
      <span>
        Amounts stay in their own currency: no saved rate for {missing.map((c) => `${c} → ${settle.homeCurrency}`).join(', ')}.{' '}
        <Link to="/account" className="text-cobalt underline">Add one in Account</Link>
      </span>
    </p>
  )
}

/** Who's on the other side of a line: one person by avatar + name, several as stacked avatars. */
function Counterparty({ people, names }: { people: SettlePerson[]; names: Map<string, string> }) {
  const shown = people.slice(0, 3)
  const only = people.length === 1 ? people[0] : undefined
  return (
    <span className="flex min-w-0 items-center gap-2 pl-2">
      <span className="flex shrink-0 -space-x-1.5" aria-hidden="true">
        {shown.map((p) => (
          <span key={p.person_id} className="rounded-full ring-2 ring-paper">
            <Avatar name={p.name} seed={p.color_seed} size={22} />
          </span>
        ))}
      </span>
      {only ? (
        <span className="min-w-0 truncate font-semibold" title={only.name}>{who(only, names)}</span>
      ) : (
        <span className="min-w-0 truncate" title={people.map((p) => p.name).join(', ')}>
          <span className="sr-only">{people.map((p) => who(p, names)).join(', ')}</span>
          {people.length > 3 && <span aria-hidden="true" className="font-semibold">+{people.length - 3}</span>}
        </span>
      )}
    </span>
  )
}

/** Currency code, then the number: codes start flush on the left, decimals line up on the right. */
function Amount({ minor, currency, incoming, muted }: { minor: number; currency: string; incoming?: boolean; muted?: boolean }) {
  return (
    <>
      <span className="num font-semibold text-ink-2">{currency}</span>
      <span className={cn('num pl-1.5 text-right font-bold', muted ? 'text-ink-2 line-through' : incoming ? 'text-cobalt-ink' : 'text-ink')}>
        {formatAmount(minor, currency)}
      </span>
    </>
  )
}

const ROW = 'flex h-10 items-center'
const LEDGER = 'grid w-full items-center text-[15px]'

/** The four ledger columns of one line: one tappable target (subgrid keeps the columns) when it opens a breakdown. */
function Line({ children, onOpen }: { children: ReactNode; onOpen?: () => void }) {
  const cls = 'col-span-4 grid grid-cols-subgrid items-center'
  if (!onOpen) return <span className={cls}>{children}</span>
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(cls, 'group/line -mx-1.5 rounded-[4px] px-1.5 text-left transition-colors hover:bg-mist-2 focus-visible:outline-2 focus-visible:outline-cobalt')}
    >
      {children}
    </button>
  )
}

/**
 * A person's balance on People, a small ledger: code · amount · to/from · who. Payments sit on
 * the payer's side; the payee sees one incoming total per currency. Each line opens the
 * breakdown, where the paying happens.
 */
export function SettleCell({ settle, entry, onOpen }: { settle: Settle; entry: PersonSettle | undefined; onOpen?: () => void }) {
  if (!settle.loaded) return null
  if (!entry || (entry.pays.length === 0 && entry.gets.length === 0 && entry.cancelOut.length === 0)) {
    return <span className={ROW}><EvenBadge /></span>
  }
  // the share page's "this opens something" cue
  const chevron = onOpen && <Icon name="next" size={16} className="ml-auto shrink-0 text-ink-2 group-hover/line:text-ink" />
  return (
    <span className={cn(LEDGER, 'max-w-[20rem] grid-cols-[auto_auto_auto_minmax(0,1fr)]')}>
      {entry.pays.map(({ payment, currency }) => (
        <Line key={`${currency}-${payment.to_person.person_id}`} onOpen={onOpen}>
          <Amount minor={payment.amount_cents} currency={currency} />
          <span className={cn(ROW, 'pl-3 text-ink-2')}>to</span>
          <span className="flex min-w-0 items-center gap-2">
            <Counterparty people={[payment.to_person]} names={settle.names} />
            {chevron}
          </span>
        </Line>
      ))}
      {entry.gets.map((g) => (
        <Line key={g.currency} onOpen={onOpen}>
          <Amount minor={g.amount} currency={g.currency} incoming />
          <span className={cn(ROW, 'pl-3 text-ink-2')}>from</span>
          <span className="flex min-w-0 items-center gap-2">
            <Counterparty people={g.from} names={settle.names} />
            {chevron}
          </span>
        </Line>
      ))}
      {entry.cancelOut.map((currency) => (
        <Line key={currency} onOpen={onOpen}>
          <span className={cn(ROW, 'col-span-3')}><EvenBadge label={`${currency} cancels out`} /></span>
          <span className="flex min-w-0 items-center">{chevron}</span>
        </Line>
      ))}
    </span>
  )
}

/** "Dev owes you", "You owe Ben", "Dev owes Ben": one bill debt, in short names. */
function debtLine(d: SettleDebt, names: Map<string, string>): string {
  const from = who(d.from_person, names)
  return `${from === 'you' ? 'You owe' : `${from} owes`} ${who(d.to_person, names)}`
}

function netLabel(p: SettlePerson, net: number, names: Map<string, string>): string {
  if (p.is_self) return net > 0 ? 'You get back' : 'You owe'
  const name = names.get(p.person_id) ?? p.name
  return net > 0 ? `${name} gets back` : `${name} owes`
}

/** One payment in the breakdown, from this person's side, with the Paid toggle. */
function PayLine({ settle, payment, currency, incoming, paid, onToggle }: {
  settle: Settle; payment: SettlePayment; currency: string; incoming: boolean; paid: boolean; onToggle: () => void
}) {
  const key = settle.payKey(payment, currency)
  return (
    <>
      <Line>
        <Amount minor={payment.amount_cents} currency={currency} incoming={incoming} muted={paid} />
        <span className={cn(ROW, 'pl-3 text-ink-2')}>{incoming ? 'from' : 'to'}</span>
        <Counterparty people={[incoming ? payment.from_person : payment.to_person]} names={settle.names} />
      </Line>
      <span className="flex justify-end pl-3">
        <PaidToggle paid={paid} received={payment.to_person.is_self} busy={settle.busy === key} onToggle={onToggle} label={payLine(payment)} />
      </span>
    </>
  )
}

/**
 * Tap a balance: the person's net per currency, what settles it (each payment with its Paid
 * toggle), and the bills behind it. Built from the share link's parts: hero amount, ruled
 * lines, a bold total row.
 */
export function SettleBreakdown({ settle }: { settle: Settle }) {
  const person = settle.detail
  const parts = person ? breakdown(settle.data, person.person_id) : []
  const open = person ? paymentsOf(settle.data, settle.view, person.person_id) : []
  const loops = person ? (settle.people.get(person.person_id)?.cancelOut ?? []) : []
  const done = person ? settle.done.filter((d) => d.people.some((p) => p.person_id === person.person_id)) : []
  const loopPeople = (currency: string) => settle.data?.groups.find((g) => g.currency === currency)?.cancel_out ?? []
  const hasPlan = open.length + loops.length + done.length > 0
  return (
    <Dialog open={Boolean(person)} onClose={settle.closeDetail} title={person ? (person.is_self ? 'You' : person.name) : ''}>
      {person && (
        <div className="flex flex-col gap-6">
          {parts.length === 0 ? (
            <EvenBadge label="All even" />
          ) : (
            <div className="flex flex-wrap gap-x-8 gap-y-3">
              {parts.map((b) =>
                b.net === 0 ? (
                  <EvenBadge key={b.currency} label={`${b.currency} nets to even`} />
                ) : (
                  <HeroAmount key={b.currency} minor={Math.abs(b.net)} currency={b.currency} size="md" label={netLabel(person, b.net, settle.names)} />
                ),
              )}
            </div>
          )}

          {hasPlan && (
            <section aria-labelledby="settle-plan-title">
              <h3 id="settle-plan-title" className="display-sm mb-1.5 text-lg">
                {settle.view === 'simplified' ? 'To settle' : 'Open debts'}
              </h3>
              <div className={cn(LEDGER, 'grid-cols-[auto_auto_auto_minmax(0,1fr)_auto] gap-y-1 border-t-[1.5px] border-ink pt-1.5')}>
                {open.map(({ payment, currency, incoming }) => (
                  <PayLine key={settle.payKey(payment, currency)} settle={settle} payment={payment} currency={currency} incoming={incoming}
                    paid={false} onToggle={() => settle.markPaid(payment, currency)} />
                ))}
                {loops.map((currency) => (
                  <Fragment key={`loop-${currency}`}>
                    <Line><span className={cn(ROW, 'col-span-4')}><EvenBadge label={`${currency} cancels out`} /></span></Line>
                    <span className="flex justify-end pl-3">
                      <PaidToggle paid={false} text="Clear" busy={settle.busy === `loop|${currency}`}
                        onToggle={() => settle.clearLoop(currency, loopPeople(currency))} label={`Clear ${currency} debts that cancel out`} />
                    </span>
                  </Fragment>
                ))}
                {done.map((d) =>
                  d.payment ? (
                    <PayLine key={d.key} settle={settle} payment={d.payment} currency={d.currency}
                      incoming={d.payment.to_person.person_id === person.person_id} paid onToggle={() => settle.unmark(d)} />
                  ) : (
                    <Fragment key={d.key}>
                      <Line><span className={cn(ROW, 'col-span-4 text-ink-2')}>{d.currency} loop cleared</span></Line>
                      <span className="flex justify-end pl-3">
                        <PaidToggle paid text="Clear" busy={settle.busy === d.key} onToggle={() => settle.unmark(d)} label={`Clear ${d.currency} debts that cancel out`} />
                      </span>
                    </Fragment>
                  ),
                )}
              </div>
            </section>
          )}

          {parts.length > 0 && (
            <section aria-labelledby="settle-bills-title">
              <h3 id="settle-bills-title" className="display-sm mb-1.5 text-lg">From the bills</h3>
              <div className="flex flex-col gap-4">
                {parts.map((b) => (
                  <ul key={b.currency} aria-label={`${b.currency} bills`} className="border-t-[1.5px] border-ink">
                    {b.lines.map(({ debt, incoming }) => (
                      <li key={`${debt.bill_id}-${debt.from_person.person_id}`} className="border-b border-rule">
                        <Link to={`/bills/${debt.bill_id}`} className="group flex min-h-[52px] items-center gap-3 py-1.5 text-ink">
                          <span className="min-w-0 flex-1">
                            <span className="block break-words text-base font-semibold group-hover:text-cobalt">{debt.title || 'Untitled bill'}</span>
                            <span className="block text-[15px] text-ink-2">
                              {[shortDate(debt.bill_date), debtLine(debt, settle.names)].filter(Boolean).join(' · ')}
                            </span>
                          </span>
                          <span className="text-right">
                            <Money minor={debt.amount_cents} currency={b.currency} code className={cn('text-base font-semibold', incoming && 'text-cobalt-ink')} />
                            {debt.currency !== b.currency && (
                              <span className="block text-[15px] text-ink-2"><Money minor={debt.original_cents} currency={debt.currency} code /></span>
                            )}
                          </span>
                          <Icon name="next" size={16} className="shrink-0 text-ink-2 group-hover:text-ink" />
                        </Link>
                      </li>
                    ))}
                    <li className="flex min-h-12 items-center justify-between gap-3 text-[17px] font-bold">
                      <span>Net</span>
                      {/* sits under the amounts, clear of the row chevrons */}
                      <span className="mr-7">
                        {b.net === 0 ? <EvenBadge /> : <Money minor={Math.abs(b.net)} currency={b.currency} code className={b.net > 0 ? 'text-cobalt-ink' : undefined} />}
                      </span>
                    </li>
                  </ul>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </Dialog>
  )
}
