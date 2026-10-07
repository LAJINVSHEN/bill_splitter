import { useRef, useState } from 'react'
import { useToast } from '@/components/Feedback'
import { useCreateShareLink, useShareLinks } from '@/data/queries'
import { ApiError } from '@/lib/api'
import { env } from '@/lib/env'
import type { ShareLinkCreated, ShareLinkOut, UUID } from '@/lib/types'

export const SHARE_LINK_LIMIT = 50
export const isShareLinkActive = (link: ShareLinkOut, now: number) => (
  !link.revoked_at && (!link.expires_at || new Date(link.expires_at).getTime() > now)
)

const absolute = (link: ShareLinkCreated) => (
  env.authMode !== 'dev' && /^https?:\/\//.test(link.url)
    ? link.url
    : new URL(link.path, window.location.origin).toString()
)

/**
 * "Send link": create a read-only link and hand it to the phone's share sheet, or copy it.
 * Reuse tokens only in this mounted hook, never in persistent storage or list metadata.
 */
export function useSendLink(billId: UUID, title: string) {
  const create = useCreateShareLink(billId)
  const metadata = useShareLinks(billId)
  const toast = useToast()
  const inFlight = useRef(false)
  const session = useRef({ billId, links: new Map<string, ShareLinkCreated>() })
  const [busy, setBusy] = useState<string | null>(null)
  /** last resort when neither share nor clipboard works: show it to copy by hand */
  const [manual, setManual] = useState<string | null>(null)

  const deliver = async (payload: { url?: string; text?: string }, copied: string) => {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, ...payload })
        return
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        // share sheet refused (e.g. activation expired): fall through to copying
      }
    }
    const text = [payload.text, payload.url].filter(Boolean).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      toast(copied)
    } catch {
      setManual(text)
    }
  }

  const fail = (err: unknown) => toast(
    err instanceof ApiError && err.code === 'too_many_links'
      ? '50-link limit reached. Revoke links below before sending more.'
      : err instanceof ApiError ? err.message : 'Couldn’t make the link. Try again.',
    'danger',
  )

  const prepare = async (personIds: Array<UUID | null>) => {
    const { data = [] } = await metadata.refetch({ throwOnError: true })
    if (session.current.billId !== billId) session.current = { billId, links: new Map() }
    const cache = session.current.links
    const now = Date.now()
    for (const [key, link] of cache) {
      if (!data.some((row) => row.id === link.id && isShareLinkActive(row, now))) cache.delete(key)
    }
    const needed = personIds.filter((id) => !cache.has(id ?? 'bill')).length
    if (data.filter((row) => !row.revoked_at).length + needed > SHARE_LINK_LIMIT) {
      throw new ApiError(400, 'too_many_links', 'Revoke some links on this bill first.')
    }
    const links: ShareLinkCreated[] = []
    for (const personId of personIds) {
      const key = personId ?? 'bill'
      let link = cache.get(key)
      if (!link) {
        link = await create.mutateAsync({ person_id: personId })
        cache.set(key, link)
      }
      links.push(link)
    }
    return links
  }

  const forget = (linkId?: UUID) => {
    for (const [key, link] of session.current.links) {
      if (!linkId || link.id === linkId) session.current.links.delete(key)
    }
    setManual(null)
  }

  /** One person's link (`personId` null = the whole bill). */
  const send = async (personId: UUID | null, name?: string) => {
    if (inFlight.current) return
    inFlight.current = true
    setManual(null)
    setBusy(personId ?? 'bill')
    try {
      const [link] = await prepare([personId])
      if (!link) throw new Error('No share link returned')
      await deliver({ url: absolute(link), ...(name ? { text: `${title}: your share` } : {}) }, 'Link copied')
    } catch (err) {
      fail(err)
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  /** Everyone who still owes, one message with a line each. */
  const sendAll = async (people: Array<{ id: UUID; name: string }>) => {
    if (!people.length || inFlight.current) return
    inFlight.current = true
    setManual(null)
    setBusy('all')
    try {
      const links = await prepare(people.map((p) => p.id))
      const text = [`${title}: what you owe`, ...people.map((p, i) => `${p.name}: ${absolute(links[i] as ShareLinkCreated)}`)].join('\n')
      await deliver({ text }, people.length === 1 ? 'Link copied' : 'Links copied')
    } catch (err) {
      fail(err)
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  return { send, sendAll, busy, manual, forget, closeManual: () => setManual(null) }
}
