import { useEffect } from 'react'
import { useParams } from 'react-router'
import { Wordmark } from '@/components/Brand'
import { Button } from '@/components/Button'
import { FullPageLoader } from '@/components/Display'
import { usePublicShare } from '@/data/queries'
import { BillShare, PersonShare } from '@/features/share/ShareView'
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

/** Public, no login: what a friend sees when they open a link from WhatsApp. */
export default function SharePage() {
  const { token = '' } = useParams()
  const share = usePublicShare(token)
  const data = share.data
  useNoIndex(data ? `${data.title || data.merchant || 'Shared bill'} · even` : 'even')

  if (share.isPending) return <FullPageLoader />

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

  return (
    <Frame>
      {data.scope === 'person' && data.person ? <PersonShare share={data} person={data.person} /> : <BillShare share={data} />}
    </Frame>
  )
}
