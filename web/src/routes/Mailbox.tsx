import { useEffect, useRef, useState } from 'react'
import { EmptyState, PageTitle, SectionTitle } from '@/components/Display'
import { useMailbox, useMarkRead } from '@/data/queries'
import { LoadError, SectionLoader } from '@/features/home/BillList'
import { RequestRow, SentRow, UpdateRow } from '@/features/mailbox/rows'

/**
 * The Mailbox: what's waiting on you (answer it: friend requests, "this placeholder is you",
 * friends' "I've paid") and what happened (accepted, edited, confirmed). In the app only: nothing is
 * pushed, so updates show as new the next time you come in. Opening the page reads them; they keep
 * their "new" look until you leave, so you can see what changed.
 */
export default function MailboxPage() {
  const mail = useMailbox()
  const read = useMarkRead()
  const data = mail.data
  // what was new when the page opened: it keeps its "new" look for this visit
  const [fresh, setFresh] = useState<Set<string> | null>(null)
  if (data && fresh === null) setFresh(new Set(data.updates.filter((u) => u.unread).map((u) => u.id)))
  const marked = useRef(false)
  useEffect(() => {
    if (!fresh?.size || marked.current) return
    marked.current = true
    read.mutate([...fresh])
  }, [fresh, read])

  const waiting = data?.requests ?? []
  const updates = data?.updates ?? []
  const sent = data?.sent ?? []
  return (
    <div className="flex flex-col gap-6 pb-6 lg:grid lg:grid-cols-[minmax(0,1fr)_var(--app-rail-w)] lg:gap-x-[var(--app-gutter)]">
      <div className="flex min-w-0 flex-col gap-8">
        <PageTitle sub={waiting.length ? `${waiting.length} waiting on you` : undefined}>Mailbox</PageTitle>
        {mail.isPending ? (
          <SectionLoader label="Loading your mailbox" />
        ) : mail.isError ? (
          <LoadError what="your mailbox" onRetry={() => void mail.refetch()} retrying={mail.isFetching} />
        ) : waiting.length === 0 && updates.length === 0 ? (
          <EmptyState title="All caught up">Friend requests, payments to confirm and changes to shared bills land here.</EmptyState>
        ) : (
          <>
            {waiting.length > 0 && (
              <section aria-labelledby="mb-waiting">
                <SectionTitle id="mb-waiting">Waiting on you</SectionTitle>
                <ul className="border-t-[1.5px] border-ink">
                  {waiting.map((r) => (
                    <RequestRow key={`${r.kind}-${r.id}`} r={r} />
                  ))}
                </ul>
              </section>
            )}
            {updates.length > 0 && (
              <section aria-labelledby="mb-updates">
                <SectionTitle id="mb-updates">Updates</SectionTitle>
                <ul className="border-t-[1.5px] border-ink">
                  {updates.map((u) => (
                    <UpdateRow key={u.id} u={u} unread={Boolean(fresh?.has(u.id))} />
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>

      {sent.length > 0 && (
        <aside aria-labelledby="mb-sent" className="lg:sticky lg:top-0 lg:self-start lg:border-l lg:border-rule lg:pl-[var(--app-gutter)] lg:pt-10">
          <SectionTitle id="mb-sent">You asked</SectionTitle>
          <ul className="border-t-[1.5px] border-ink">
            {sent.map((s) => (
              <SentRow key={`${s.kind}-${s.id}`} s={s} />
            ))}
          </ul>
        </aside>
      )}
    </div>
  )
}
