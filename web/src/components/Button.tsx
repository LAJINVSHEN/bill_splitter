import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Link, type LinkProps } from 'react-router'
import { cn } from '@/lib/cn'
import { EqualsMark } from './Brand'

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger'
export type ButtonSize = 'md' | 'lg' | 'sm'

const VARIANT: Record<ButtonVariant, string> = {
  // the one strong action on a screen
  primary: 'bg-cobalt text-white hover:bg-cobalt-ink disabled:bg-mist-2 disabled:text-ink-2',
  // alternatives: outlined in ink, never grey
  secondary: 'border-[1.5px] border-ink text-ink bg-paper hover:bg-mist disabled:border-rule-2 disabled:text-ink-2',
  // inline actions inside rows and headers
  quiet: 'text-cobalt hover:text-cobalt-ink disabled:text-ink-2 px-0',
  danger: 'text-danger hover:underline px-0',
}
const SIZE: Record<ButtonSize, string> = {
  sm: 'h-10 px-3.5 text-[15px]',
  md: 'h-12 px-5 text-base',
  lg: 'h-[54px] px-6 text-[17px]',
}

function classes(variant: ButtonVariant, size: ButtonSize, block?: boolean, className?: string) {
  return cn(
    'inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] font-bold whitespace-nowrap transition-colors',
    variant === 'quiet' || variant === 'danger' ? 'h-11 text-[15px]' : SIZE[size],
    VARIANT[variant],
    block && 'w-full',
    className,
  )
}

interface CommonProps {
  variant?: ButtonVariant
  size?: ButtonSize
  block?: boolean
  icon?: ReactNode
  children?: ReactNode
  className?: string
}

export function Button({
  variant = 'primary',
  size = 'md',
  block,
  icon,
  loading,
  children,
  className,
  type = 'button',
  disabled,
  ...rest
}: CommonProps & { loading?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={classes(variant, size, block, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <EqualsMark size="sm" moving tone={variant === 'primary' ? 'white' : 'cobalt'} /> : icon}
      {children}
    </button>
  )
}

export function ButtonLink({ variant = 'primary', size = 'md', block, icon, children, className, ...rest }: CommonProps & LinkProps) {
  return (
    <Link className={classes(variant, size, block, className)} {...rest}>
      {icon}
      {children}
    </Link>
  )
}
