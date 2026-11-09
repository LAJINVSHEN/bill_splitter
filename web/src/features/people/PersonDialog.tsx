import { useState } from 'react'
import { Button } from '@/components/Button'
import { Avatar, Notice } from '@/components/Display'
import { Dialog, useToast } from '@/components/Feedback'
import { SelectField } from '@/components/Field'
import { Icon } from '@/components/Icon'
import { useFriendAction, useFriends, useLinkPerson } from '@/data/queries'
import { dayOf } from '@/features/home/format'
import { ApiError } from '@/lib/api'
import type { PersonOut } from '@/lib/types'

/**
 * One person, beyond their balance. A placeholder can be tagged with a friend's account: once
 * the friend says it's them, every bill with the placeholder is shared with them. A friend can
 * be unfriended (history stays on every bill) or blocked.
 */
export function PersonDialog({ person, onClose, onBalance, onRemove }: {
  person: PersonOut | null
  onClose: () => void
  /** their balance breakdown, when they have one */
  onBalance?: () => void
  /** archive / delete (the existing flow) */
  onRemove: (p: PersonOut) => void
}) {
  const friends = useFriends(Boolean(person))
  const link = useLinkPerson()
  const act = useFriendAction()
  const toast = useToast()
  const [pick, setPick] = useState('')
  const [confirm, setConfirm] = useState<'unfriend' | 'block' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    setPick('')
    setConfirm(null)
    setError(null)
    onClose()
  }
  const fail = (err: unknown) => setError(err instanceof ApiError ? err.message : 'Couldn’t save. Try again.')

  if (!person) return <Dialog open={false} onClose={close} title="">{null}</Dialog>
  const friend = friends.data?.friends.find((f) => f.account.id === person.account_id)
  const isFriend = Boolean(person.account_id)
  const first = person.name.split(' ')[0] ?? person.name
  const candidates = (friends.data?.friends ?? []).filter((f) => f.person_id !== person.id)

  const ask = () =>
    link.mutate(
      { personId: person.id, accountId: pick },
      {
        onSuccess: () => {
          const who = candidates.find((f) => f.account.id === pick)?.account.name ?? 'They'
          toast(`Asked ${who.split(' ')[0]}`)
          setPick('')
        },
        onError: fail,
      },
    )
  const takeBack = () => link.mutate({ personId: person.id, accountId: null }, { onError: fail })
  const end = (action: 'unfriend' | 'block') =>
    act.mutate(
      { action, id: person.account_id ?? '' },
      { onSuccess: () => { toast(action === 'block' ? `${first} is blocked` : `You and ${first} aren’t friends now`); close() }, onError: fail },
    )

  const fact = isFriend
    ? `@${person.username}${friend ? ` · friends since ${dayOf(friend.since)}` : ''}`
    : person.pending_link_to
      ? `Waiting for ${person.pending_link_to.split(' ')[0]} to say it’s them`
      : 'Only on your bills'

  return (
    <Dialog open onClose={close} title={person.name}>
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <Avatar name={person.name} seed={person.color_seed} size={44} />
          <div className="min-w-0">
            <p className="break-words text-[17px] font-semibold">{person.name}</p>
            <p className="text-[15px] text-ink-2">{fact}</p>
          </div>
          {onBalance && (
            <Button variant="quiet" className="ml-auto shrink-0" onClick={onBalance}>
              Balance
            </Button>
          )}
        </div>

        {error && <Notice tone="danger">{error}</Notice>}

        {!isFriend && !person.pending_link_to && (
          <section aria-labelledby="pd-link" className="flex flex-col gap-3">
            <h3 id="pd-link" className="display-sm text-lg">Is {first} on even?</h3>
            {candidates.length === 0 ? (
              <p className="text-[15px] text-ink-2">Add {first} as a friend first, then link them here.</p>
            ) : (
              <>
                <SelectField label="Their account" value={pick} onChange={(e) => setPick(e.target.value)}>
                  <option value="">Choose a friend</option>
                  {candidates.map((f) => (
                    <option key={f.account.id} value={f.account.id}>
                      {f.account.name} (@{f.account.username})
                    </option>
                  ))}
                </SelectField>
                <Button className="self-start" icon={<Icon name="link" size={18} />} disabled={!pick} loading={link.isPending} onClick={ask}>
                  Ask them to take over {first}
                </Button>
              </>
            )}
          </section>
        )}

        {person.pending_link_to && (
          <Button variant="secondary" className="self-start" loading={link.isPending} onClick={takeBack}>
            Take back the invite
          </Button>
        )}

        {isFriend && !person.is_self && (
          confirm ? (
            <Notice
              tone={confirm === 'block' ? 'danger' : 'warn'}
              action={
                <span className="-my-2.5 flex shrink-0 gap-3">
                  <Button variant="quiet" onClick={() => setConfirm(null)}>Keep</Button>
                  <Button variant="quiet" className={confirm === 'block' ? 'text-danger' : undefined} loading={act.isPending} onClick={() => end(confirm)}>
                    {confirm === 'block' ? 'Block' : 'Unfriend'}
                  </Button>
                </span>
              }
            >
              {confirm === 'block'
                ? `${first} can’t ask you again or add you to new bills.`
                : `Your bills together stay shared. You can’t add ${first} to new ones.`}
            </Notice>
          ) : (
            <div className="flex flex-wrap gap-x-6 border-t border-rule pt-3">
              <Button variant="quiet" onClick={() => setConfirm('unfriend')}>Unfriend</Button>
              <Button variant="quiet" className="text-danger" onClick={() => setConfirm('block')}>Block</Button>
            </div>
          )
        )}

        {!isFriend && !person.is_self && (
          <div className="border-t border-rule pt-3">
            <Button variant="quiet" className="text-danger" icon={<Icon name="trash" size={18} />} onClick={() => { close(); onRemove(person) }}>
              Archive or delete
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  )
}
