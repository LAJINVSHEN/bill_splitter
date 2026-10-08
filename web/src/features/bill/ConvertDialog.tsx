import { useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { Button } from '@/components/Button'
import { Money, Notice } from '@/components/Display'
import { Dialog } from '@/components/Feedback'
import { controlClass, SelectField } from '@/components/Field'
import { qk, useFxRates, usePatchBill } from '@/data/queries'
import { cn } from '@/lib/cn'
import { exponentOf } from '@/lib/money'
import { convertMinor } from '@/lib/split'
import type { BillOut } from '@/lib/types'
import { isRateText, savedRate, validRate } from './fx'
import { CurrencyOptions, DecimalInput } from './inputs'

/**
 * "Show in SGD": settle this bill in another currency at a rate the person types (prefilled from
 * their saved rates, either direction). The rate is snapshotted onto the bill.
 */
export function ConvertDialog({ bill, home, open, onClose }: { bill: BillOut; home: string; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={bill.settle_currency ? 'Conversion' : `Show in ${defaultTarget(bill, home)}`}>
      {open && <ConvertBody bill={bill} home={home} onClose={onClose} />}
    </Dialog>
  )
}

const defaultTarget = (bill: BillOut, home: string) => bill.settle_currency ?? (bill.currency !== home ? home : 'USD')

function ConvertBody({ bill, home, onClose }: { bill: BillOut; home: string; onClose: () => void }) {
  const qc = useQueryClient()
  const rates = useFxRates()
  const patch = usePatchBill(bill.id)
  const rateId = useId()
  const [target, setTarget] = useState(defaultTarget(bill, home))
  const saved = savedRate(rates.data, bill.currency, target)
  const [typed, setTyped] = useState<string | null>(bill.settle_currency === target && bill.fx_rate ? bill.fx_rate.replace(/\.?0+$/, '') : null)
  const rate = typed ?? saved?.rate ?? ''
  const [remember, setRemember] = useState(true)
  const ok = validRate(rate) && target !== bill.currency
  const grand = bill.grand_total_cents ?? bill.split.grand_total_cents
  const converted = ok ? convertMinor(grand, rate, exponentOf(bill.currency), exponentOf(target)) : null
  const changed = !saved || saved.rate !== rate

  const apply = () =>
    patch.mutate(
      { settle_currency: target, fx_rate: rate, save_rate: remember && changed },
      {
        onSuccess: () => {
          if (remember && changed) void qc.invalidateQueries({ queryKey: qk.fxRates })
          onClose()
        },
      },
    )

  return (
    <div className="flex flex-col gap-4">
      <SelectField
        label="Show amounts in"
        value={target}
        onChange={(e) => {
          setTarget(e.target.value)
          setTyped(null)
        }}
      >
        <CurrencyOptions />
      </SelectField>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={rateId} className="text-[15px] font-semibold">
          Rate
        </label>
        <div className="flex items-center gap-2.5 text-[17px] font-semibold">
          <span className="num shrink-0">1 {bill.currency} =</span>
          <DecimalInput id={rateId} allow={isRateText} value={rate} onChange={setTyped} placeholder="0.00" className={cn(controlClass, 'min-w-0 flex-1')} aria-invalid={rate !== '' && !validRate(rate) ? true : undefined} />
          <span className="shrink-0">{target}</span>
        </div>
      </div>
      {converted !== null && (
        <p className="text-[16px] font-semibold">
          <Money minor={grand} currency={bill.currency} code /> → <Money minor={converted} currency={target} code />
        </p>
      )}
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[16px] font-medium">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-[22px] w-[22px] accent-cobalt" />
        Save this rate for next time
      </label>
      {target === bill.currency && <Notice tone="warn">Pick a different currency from the bill’s.</Notice>}
      {patch.error && <Notice tone="danger">{patch.error.message}</Notice>}
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-rule pt-3">
        {bill.settle_currency ? (
          <Button variant="danger" loading={patch.isPending && patch.variables?.settle_currency === null} onClick={() => patch.mutate({ settle_currency: null }, { onSuccess: onClose })}>
            Back to {bill.currency}
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2.5">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ok} loading={patch.isPending && patch.variables?.settle_currency !== null} onClick={apply}>
            Show in {target}
          </Button>
        </div>
      </div>
    </div>
  )
}
