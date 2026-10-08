import type { ReactNode } from 'react'
import { Money } from '@/components/Display'
import type { ValidationOut } from '@/lib/types'

/**
 * One plain sentence for what doesn't add up, with the real numbers.
 * Null when there's nothing worth saying (including an empty receipt still being typed).
 */
export function validationText(v: ValidationOut | null | undefined, currency: string, hasPhoto: boolean): ReactNode {
  if (!v || v.ok) {
    if (!v?.warnings.length) return null
  }
  const m = (minor: number) => (
    <strong>
      <Money minor={minor} currency={currency} />
    </strong>
  )
  const err = v?.errors[0]
  if (err) {
    switch (err.code) {
      case 'no_items':
        return null
      case 'grand_total_missing':
        return 'Enter the total from the receipt.'
      case 'items_subtotal_mismatch':
        return (
          <>
            Items add up to {m(v.items_total_cents)}, but the receipt’s subtotal is {m(v.provided_subtotal_cents ?? 0)}.
            {hasPhoto && ' One price is probably misread — compare with the photo.'}
          </>
        )
      case 'grand_total_mismatch':
      case 'items_grand_mismatch':
      case 'no_scenario_matches':
        return (
          <>
            Items and charges come to {m(v.items_total_cents + v.charges_total_cents)}, but the total is {m(v.grand_total_cents)}.
          </>
        )
      default:
        return v.message ?? err.message
    }
  }
  const n = v?.warnings.length ?? 0
  return n ? `On ${n} ${n === 1 ? 'line' : 'lines'}, qty × each doesn’t match the amount.` : null
}
