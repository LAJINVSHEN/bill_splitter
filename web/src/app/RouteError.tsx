import { isRouteErrorResponse, useRouteError } from 'react-router'
import { Wordmark } from '@/components/Brand'
import { Button, ButtonLink } from '@/components/Button'

/** Last line of defence: a crash or a failed lazy chunk (usually right after a deploy). */
export function RouteError() {
  const error = useRouteError()
  const chunkFailed = error instanceof Error && /dynamically imported module|Loading chunk|Importing a module script failed/i.test(error.message)
  const notFound = isRouteErrorResponse(error) && error.status === 404
  return (
    <main className="mx-auto flex min-h-dvh max-w-[480px] flex-col gap-5 px-6 pt-[14vh]">
      <Wordmark />
      <h1 className="display text-[34px]">{notFound ? 'Not here' : chunkFailed ? 'There’s a new version' : 'Something broke'}</h1>
      <p className="text-[17px] text-ink-2">
        {chunkFailed
          ? 'even was updated while this tab was open. Reload to get the latest version — your work is saved.'
          : notFound
            ? 'The link may be old.'
            : 'Your work is saved. Reload, or go back home and pick up where you left off.'}
      </p>
      <div className="flex gap-2.5">
        <Button onClick={() => window.location.reload()}>Reload</Button>
        <ButtonLink to="/" variant="secondary">
          Home
        </ButtonLink>
      </div>
    </main>
  )
}
