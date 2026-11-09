import { useState, type FormEvent } from 'react'
import { Button } from '@/components/Button'
import { Avatar, EvenBadge } from '@/components/Display'
import { Dialog, useToast } from '@/components/Feedback'
import { TextField } from '@/components/Field'
import { useAskFriend, useFriends } from '@/data/queries'
import { ApiError } from '@/lib/api'
import type { AccountBrief } from '@/lib/types'

const plural = (n: number) => (n === 1 ? '1 shared bill' : `${n} shared bills`)

/**
 * Ask by exact email or user id. The answer is the same whether or not an account matched (so
 * nobody can probe who's on even), and only a reply in their Mailbox tells you more. People you
 * already share bills with are one tap away, no email needed.
 */
export function AddFriendDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ask = useAskFriend()
  const friends = useFriends(open)
  const toast = useToast()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [asked, setAsked] = useState<Set<string>>(new Set())

  const close = () => {
    setValue('')
    setError(null)
    setSentTo(null)
    onClose()
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const ident = value.trim()
    if (ident.replace(/^@/, '').length < 2) return setError('Type their email or user id.')
    setError(null)
    try {
      const out = await ask.mutateAsync({ identifier: ident })
      if (out.status === 'accepted') {
        toast('They’d already asked you: you’re friends now')
        close()
      } else setSentTo(ident)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t send. Try again.')
    }
  }

  async function askAccount(a: AccountBrief) {
    try {
      const out = await ask.mutateAsync({ account_id: a.id })
      setAsked((s) => new Set(s).add(a.id))
      toast(out.status === 'accepted' ? `You and ${a.name} are friends` : `Asked ${a.name}`)
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t send. Try again.', 'danger')
    }
  }

  const suggestions = friends.data?.suggestions ?? []
  return (
    <Dialog open={open} onClose={close} title="Add a friend">
      <div className="flex flex-col gap-6">
        {sentTo ? (
          <div className="flex flex-col items-start gap-3">
            <EvenBadge label="Request sent" />
            <p className="break-words text-[16px]">
              If <span className="font-semibold">{sentTo}</span> is on even, they’ll find it in their Mailbox. You’ll hear back there.
            </p>
            <div className="flex gap-2.5">
              <Button variant="secondary" onClick={() => { setSentTo(null); setValue('') }}>
                Ask someone else
              </Button>
              <Button onClick={close}>Done</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-3">
            <div className="min-w-0">
              <TextField
                label="Their email or user id"
                placeholder="maya@gmail.com or @maya"
                value={value}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                maxLength={254}
                onChange={(e) => {
                  setValue(e.target.value)
                  setError(null)
                }}
                error={error}
              />
            </div>
            <Button type="submit" className="self-start" loading={ask.isPending && Boolean(ask.variables && 'identifier' in ask.variables)}>
              Send request
            </Button>
          </form>
        )}

        {suggestions.length > 0 && (
          <section aria-labelledby="af-suggest">
            <h3 id="af-suggest" className="display-sm mb-1.5 text-lg">On your bills</h3>
            <ul className="border-t-[1.5px] border-ink">
              {suggestions.map(({ account, shared_bills }) => (
                <li key={account.id} className="flex min-h-[56px] items-center gap-3 border-b border-rule py-1.5">
                  <Avatar name={account.name} seed={account.color_seed} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[16px] font-semibold">{account.name}</span>
                    <span className="truncate text-[14px] text-ink-2">@{account.username} · {plural(shared_bills)}</span>
                  </span>
                  {asked.has(account.id) ? (
                    <span className="text-[15px] font-semibold text-ink-2">Asked</span>
                  ) : (
                    <Button variant="quiet" className="shrink-0" onClick={() => void askAccount(account)}>
                      Ask
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Dialog>
  )
}
