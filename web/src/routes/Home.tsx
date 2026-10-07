import { Link } from 'react-router'
import { Wordmark } from '@/components/Brand'
import { useMe, useSummary, useUsage } from '@/data/queries'
import { LoadError, SectionLoader } from '@/features/home/BillList'
import { Debtors, InProgress, OwedHero, RecentBills, StartBill } from '@/features/home/HomeSections'

/** Home: what I'm owed, who owes it, start or resume a bill, and the latest finished ones. */
export default function HomePage() {
  const me = useMe()
  const summary = useSummary()
  const usage = useUsage()
  const homeCurrency = me.data?.default_currency ?? summary.data?.home.currency ?? 'SGD'

  return (
    <div className="flex flex-col gap-8 pt-4 md:gap-12 md:pt-10">
      {/* phones have no sidebar: the wordmark and a way to the account live here */}
      <header className="flex items-center justify-between md:hidden">
        <Wordmark size="sm" />
        {me.data && (
          <Link
            to="/account"
            aria-label="Account"
            className="grid h-11 w-11 place-items-center rounded-full border-[1.5px] border-ink text-[15px] font-bold text-ink"
          >
            {(me.data.display_name.trim()[0] ?? '?').toUpperCase()}
          </Link>
        )}
      </header>

      <h1 className="sr-only">Home</h1>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(420px,100%),1fr))] gap-8 md:gap-12">
        <div>
          {summary.isPending ? (
            <SectionLoader label="Loading balances" />
          ) : summary.isError ? (
            <LoadError what="your balances" onRetry={() => void summary.refetch()} retrying={summary.isFetching} />
          ) : (
            <>
              <OwedHero summary={summary.data} />
              <Debtors summary={summary.data} />
            </>
          )}
        </div>
        <div className="flex flex-col gap-8">
          <StartBill usage={usage.data} />
          <InProgress />
        </div>
      </div>

      <RecentBills summary={summary.data} homeCurrency={homeCurrency} />
    </div>
  )
}
