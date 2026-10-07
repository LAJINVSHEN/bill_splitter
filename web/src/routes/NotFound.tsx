import { ButtonLink } from '@/components/Button'
import { EmptyState, PageTitle } from '@/components/Display'

export default function NotFound() {
  return (
    <div className="px-[var(--app-gutter)]">
      <PageTitle>Not here</PageTitle>
      <div className="mt-6">
        <EmptyState title="This page doesn’t exist" action={<ButtonLink to="/">Go home</ButtonLink>}>
          The link may be old, or the bill may have been deleted.
        </EmptyState>
      </div>
    </div>
  )
}
