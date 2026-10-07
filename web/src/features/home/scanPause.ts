import type { UsageOut } from '@/lib/types'

/** Why scanning is paused, in one plain sentence. Null when scanning works. */
export function scanPauseText(usage: Pick<UsageOut, 'scans_paused' | 'pause_reason' | 'pages_quota'> | undefined): string | null {
  if (!usage?.scans_paused) return null
  switch (usage.pause_reason as string | null) {
    case 'user_quota':
      return `You’ve used all ${usage.pages_quota} scans this month.`
    case 'scans_disabled':
      return 'Scanning is switched off for now.'
    case 'global_page_cap':
    case 'llm_budget':
    case 'provider_quota':
      return 'Scanning is paused for everyone until next month.'
    default:
      return 'Scanning is paused for now.'
  }
}
