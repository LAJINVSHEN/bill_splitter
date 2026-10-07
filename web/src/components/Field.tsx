import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

const CONTROL =
  'h-12 w-full rounded-[var(--radius-control)] border-[1.5px] border-ink bg-paper px-3.5 text-[17px] font-medium text-ink outline-none placeholder:text-ink-2 focus:border-cobalt focus:ring-2 focus:ring-cobalt-soft aria-[invalid=true]:border-danger disabled:border-rule-2 disabled:bg-mist'

interface FieldChrome {
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  labelAction?: ReactNode
  hideLabel?: boolean
}

function Chrome({ id, label, hint, error, labelAction, hideLabel, children }: FieldChrome & { id: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className={cn('flex items-baseline justify-between gap-3', hideLabel && 'sr-only')}>
        <label htmlFor={id} className="text-[15px] font-semibold">
          {label}
        </label>
        {labelAction}
      </div>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-[15px] font-semibold text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[15px] text-ink-2">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export const TextField = forwardRef<HTMLInputElement, FieldChrome & InputHTMLAttributes<HTMLInputElement>>(function TextField(
  { label, hint, error, labelAction, hideLabel, className, id: idProp, ...rest },
  ref,
) {
  const autoId = useId()
  const id = idProp ?? autoId
  return (
    <Chrome id={id} label={label} hint={hint} error={error} labelAction={labelAction} hideLabel={hideLabel}>
      <input
        ref={ref}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cn(CONTROL, className)}
        {...rest}
      />
    </Chrome>
  )
})

/** One dropdown everywhere: a native <select> in brand dress (playbook §1.5.5). */
export const SelectField = forwardRef<HTMLSelectElement, FieldChrome & SelectHTMLAttributes<HTMLSelectElement>>(function SelectField(
  { label, hint, error, labelAction, hideLabel, className, id: idProp, children, ...rest },
  ref,
) {
  const autoId = useId()
  const id = idProp ?? autoId
  return (
    <Chrome id={id} label={label} hint={hint} error={error} labelAction={labelAction} hideLabel={hideLabel}>
      <select ref={ref} id={id} aria-invalid={error ? true : undefined} className={cn(CONTROL, 'appearance-auto pr-2 font-semibold', className)} {...rest}>
        {children}
      </select>
    </Chrome>
  )
})

/** Bare control styles for inline editing (tables), without the label chrome. */
export const controlClass = CONTROL
