import type { ReactNode } from 'react'
import { Button } from '@/components/Button'
import { Meter, Notice, SectionTitle } from '@/components/Display'
import { useToast } from '@/components/Feedback'
import { useUpdateSettings } from '@/data/queries'
import { monthName } from '@/features/home/format'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { AdminSettingsOut, AdminUsageOut } from '@/lib/types'
import { formatUsd } from './logic'

function Stat({ label, value, of, meter }: { label: string; value: ReactNode; of?: ReactNode; meter?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[15px] font-semibold text-ink-2">{label}</span>
      <span className="hero-num text-[32px]">
        {value}
        {of && <span className="ml-1.5 text-[18px] text-ink-2">/ {of}</span>}
      </span>
      {meter}
    </div>
  )
}

/** Close to a cap is worth a look; at it, scanning has stopped. */
const nearCap = (used: number, cap: number) => cap > 0 && used >= cap * 0.9

export function ThisMonth({ usage, settings }: { usage: AdminUsageOut; settings: AdminSettingsOut | undefined }) {
  const month = monthName(usage.month)
  const pageCap = settings?.provider?.effective_monthly_page_cap ?? usage.global_monthly_page_cap
  const pages = usage.totals.ocr_pages
  const spend = usage.totals.cost_micros
  const budget = usage.global_monthly_llm_budget_micros
  const llm = settings?.llm
  const totalCalls = usage.by_model.reduce((s, m) => s + m.calls, 0)
  const fallbackCalls = usage.by_model.find((m) => m.model === llm?.fallback_model)?.calls ?? 0
  const fallbackShare = totalCalls > 0 ? Math.round((fallbackCalls / totalCalls) * 100) : 0

  return (
    <section aria-label="This month" className="flex flex-col gap-6">
      <ProviderPause settings={settings} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] gap-6 border-t-[1.5px] border-ink pt-4 md:gap-8">
        <Stat
          label={`Azure pages · ${month}`}
          value={<span className="num">{pages}</span>}
          of={<span className="num">{pageCap}</span>}
          meter={<Meter value={pages} max={pageCap} label="Azure pages used" tone={nearCap(pages, pageCap) ? 'warn' : 'cobalt'} />}
        />
        <Stat
          label={`OpenAI spend · ${month}`}
          value={formatUsd(spend)}
          of={formatUsd(budget)}
          meter={<Meter value={spend} max={budget} label="OpenAI budget used" tone={nearCap(spend, budget) ? 'warn' : 'cobalt'} />}
        />
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[15px] font-semibold text-ink-2">Models</span>
          {llm && <span className="truncate text-[17px] font-semibold">{llm.primary_model}</span>}
          {llm?.fallback_model && (
            <span className="text-[15px] text-ink-2">
              falls back to <span className="font-semibold text-ink">{llm.fallback_model}</span>
              {totalCalls > 0 && ` · ${fallbackShare}% of calls`}
            </span>
          )}
        </div>
      </div>
      {usage.by_model.length > 0 && <ByModel usage={usage} />}
    </section>
  )
}

function ByModel({ usage }: { usage: AdminUsageOut }) {
  return (
    <div>
      <SectionTitle>By model</SectionTitle>
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-base">
          <thead>
            <tr className="border-t-[1.5px] border-b border-ink border-b-rule text-left text-[14px] text-ink-2">
              <th scope="col" className="py-2.5 font-semibold">
                Model
              </th>
              <th scope="col" className="w-[90px] py-2.5 text-right font-semibold">
                Calls
              </th>
              <th scope="col" className="w-[100px] py-2.5 text-right font-semibold">
                Failed
              </th>
              <th scope="col" className="w-[120px] py-2.5 text-right font-semibold">
                Avg time
              </th>
              <th scope="col" className="w-[100px] py-2.5 text-right font-semibold">
                Cost
              </th>
            </tr>
          </thead>
          <tbody>
            {usage.by_model.map((m) => (
              <tr key={m.model} className="border-b border-rule">
                <td className="py-3 pr-3 font-semibold">{m.model}</td>
                <td className="num py-3 text-right">{m.calls}</td>
                <td className={cn('num py-3 text-right', m.failed_calls > 0 ? 'font-semibold text-warn' : '')}>{m.failed_calls}</td>
                <td className="num py-3 text-right">{(m.avg_latency_ms / 1000).toFixed(1)} s</td>
                <td className="num py-3 text-right font-semibold">{formatUsd(m.cost_micros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Azure said its free quota is used up: scanning is paused; the admin can lift it (e.g. after upgrading). */
function ProviderPause({ settings }: { settings: AdminSettingsOut | undefined }) {
  const update = useUpdateSettings()
  const toast = useToast()
  const month = settings?.provider?.provider_paused_month
  if (!month) return null
  return (
    <Notice
      action={
        <Button
          variant="quiet"
          className="-my-3"
          loading={update.isPending}
          onClick={() =>
            update.mutate(
              { provider_paused: false },
              { onError: (e) => toast(e instanceof ApiError ? e.message : 'Couldn’t resume scans. Try again.', 'danger') },
            )
          }
        >
          Resume scans
        </Button>
      }
    >
      Azure reported its pages used up for {monthName(month)}. Scans are paused.
    </Notice>
  )
}
