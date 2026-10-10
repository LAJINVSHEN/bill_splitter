import { useEffect, useState } from 'react'
import { useLocation, useParams } from 'react-router'
import { EqualsMark, Wordmark } from '@/components/Brand'
import { Button } from '@/components/Button'
import { HeroAmount } from '@/components/Display'
import { usePublicShare } from '@/data/queries'
import { ClaimPanel } from '@/features/share/ClaimPanel'
import { parseFragment, pickedName, setPickedName, useClaims, type Fragment } from '@/features/share/claims'
import { billFractions, firstName } from '@/features/share/logic'
import { PersonShare, PickName } from '@/features/share/ShareView'
import { ApiError } from '@/lib/api'

/** Share links are private by nature: keep them out of search engines while this page is open. */
function useNoIndex(title: string) {
  useEffect(() => {
    const meta = document.createElement('meta')
    meta.name = 'robots'
    meta.content = 'noindex, nofollow'
    document.head.appendChild(meta)
    return () => meta.remove()
  }, [])
  useEffect(() => {
    const previous = document.title
    document.title = title
    return () => {
      document.title = previous
    }
  }, [title])
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-mist px-4 pb-8 pt-5">
      <div className="mx-auto flex w-full max-w-[480px] flex-col gap-4">
        <header className="px-1">
          <Wordmark size="sm" />
        </header>
        {children}
      </div>
    </div>
  )
}

/** True after `ms`: the "this can take a minute" line only shows when it actually does. */
function useAfter(ms: number) {
  const [late, setLate] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setLate(true), ms)
    return () => window.clearTimeout(t)
  }, [ms])
  return late
}

/** First paint before the server answers (it may be waking up): the amount from the link itself. */
function Shell({ fragment }: { fragment: Fragment }) {
  const late = useAfter(8_000)
  return (
    <Frame>
      <main className="flex flex-col gap-5 rounded-[var(--radius-panel)] border-[1.5px] border-ink bg-paper px-5 py-6">
        {fragment?.kind === 'person' && <HeroAmount minor={fragment.minor} currency={fragment.currency} label="Your share" />}
        <p role="status" className="flex items-start gap-3 text-[16px] font-semibold">
          <EqualsMark size="sm" moving />
          <span>
            Getting the latest…
            {late && <span className="block font-medium text-ink-2">Waking the server. This can take up to a minute.</span>}
          </span>
        </p>
      </main>
    </Frame>
  )
}

/** Public, no login: what a friend sees when they open a link from a chat. */
export default function SharePage() {
  const { token = '' } = useParams()
  const { hash } = useLocation()
  const fragment = parseFragment(hash)
  const share = usePublicShare(token)
  const claims = useClaims(token)
  const [picked, setPicked] = useState<string | null>(() => pickedName(token))
  const data = share.data
  useNoIndex(data ? `${data.title || data.merchant || 'Shared bill'} · even` : 'even')

  if (share.isPending) return <Shell fragment={fragment} />

  if (share.isError || !data) {
    const gone = share.error instanceof ApiError && share.error.status === 404
    return (
      <Frame>
        <main className="flex flex-col gap-3 rounded-[var(--radius-panel)] border-[1.5px] border-ink bg-paper px-5 py-6">
          <h1 className="display text-[28px] leading-[1.1]">{gone ? 'This link has expired or was turned off' : 'Couldn’t open this bill'}</h1>
          <p className="text-[17px] text-ink-2">{gone ? 'Ask whoever sent it for a new one.' : 'Check your connection and try again.'}</p>
          {!gone && (
            <Button className="self-start" loading={share.isFetching} onClick={() => void share.refetch()}>
              Try again
            </Button>
          )}
        </main>
      </Frame>
    )
  }

  if (data.scope === 'person' && data.person) {
    return (
      <Frame>
        <PersonShare share={data} person={data.person} footer={<ClaimPanel token={token} share={data} person={data.person} claims={claims} personKey={null} />} />
      </Frame>
    )
  }

  const me = data.people.find((p) => p.key === picked)
  const pick = (key: string | null) => {
    setPickedName(token, key)
    setPicked(key)
    window.scrollTo({ top: 0 })
  }
  if (!me) return <Frame><PickName share={data} onPick={pick} /></Frame>
  return (
    <Frame>
      <PersonShare
        share={data}
        person={me}
        fractions={billFractions(data.people)}
        footer={
          <>
            <ClaimPanel token={token} share={data} person={me} claims={claims} personKey={me.key} />
            <Button variant="quiet" className="self-start px-1" onClick={() => pick(null)}>
              Not {firstName(me.name)}? See everyone
            </Button>
          </>
        }
      />
    </Frame>
  )
}
