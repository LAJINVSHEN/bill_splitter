import { useMe, useSummary, useUsage } from '@/data/queries'
import { InProgress, RecentBills, StartBill } from '@/features/home/HomeSections'
import { WaitingOnYou } from '@/features/mailbox/WaitingOnYou'
import { HomeBalance } from '@/features/settle/YourBalance'

/** Home: start a bill (scan first), your balance, resume one, and the latest ones. Who-owes-whom lives on People. */
export default function HomePage() {
  const me = useMe()
  const summary = useSummary()
  const usage = useUsage()
  const homeCurrency = me.data?.default_currency ?? summary.data?.home.currency ?? 'SGD'

  return (
    <div className="flex flex-col gap-8 pt-1 md:gap-12 md:pt-10">
      <h1 className="sr-only">Home</h1>

      {/* anything waiting on you (friends' "I've paid", requests) first: a line into the Mailbox */}
      <WaitingOnYou />

      {/* Starting a bill is the first thing on the page; scanning/uploading leads. */}
      <StartBill usage={usage.data} />
      {/* where you stand, one line per currency, right before the work in progress */}
      <HomeBalance summary={summary.data} homeCurrency={homeCurrency} />
      <InProgress />
      <RecentBills summary={summary.data} homeCurrency={homeCurrency} />
    </div>
  )
}
