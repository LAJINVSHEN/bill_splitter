import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import type { ShareLinkOut } from '@/lib/types'
import { useSendLink } from './useSendLink'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  refetch: vi.fn(),
  toast: vi.fn(),
  env: { authMode: 'dev' },
}))

vi.mock('@/data/queries', () => ({
  useCreateShareLink: () => ({ mutateAsync: mocks.create }),
  useShareLinks: () => ({ refetch: mocks.refetch }),
}))
vi.mock('@/components/Feedback', () => ({ useToast: () => mocks.toast }))
vi.mock('@/lib/env', () => ({ env: mocks.env }))

const path = '/s/one-time-token'
const localUrl = () => new URL(path, window.location.origin).toString()
let writeText: ReturnType<typeof vi.fn>
let records: ShareLinkOut[]

const record = (id = 'link-maya'): ShareLinkOut => ({
  id, person_id: 'maya', created_at: '2026-10-07T12:00:00Z',
  expires_at: null, revoked_at: null, last_viewed_at: null,
})

beforeEach(() => {
  vi.resetAllMocks()
  mocks.env.authMode = 'dev'
  records = []
  mocks.refetch.mockImplementation(async () => ({ data: records }))
  mocks.create.mockImplementation(async ({ person_id }: { person_id: string | null }) => {
    const row = { ...record(`link-${person_id}`), person_id }
    records = [...records, row]
    return { ...row, url: `http://localhost:3000${path}`, path }
  })
  writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
})

afterEach(() => vi.unstubAllGlobals())

describe('useSendLink delivery', () => {
  it('passes separate URL and text to native share using the current dev origin', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { share, clipboard: { writeText } })
    const { result } = renderHook(() => useSendLink('bill', 'Dinner'))
    await act(async () => { await result.current.send('maya', 'Maya') })
    expect(share).toHaveBeenCalledWith({ title: 'Dinner', text: 'Dinner: your share', url: localUrl() })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('copies the message and URL when native sharing is unavailable', async () => {
    const { result } = renderHook(() => useSendLink('bill', 'Dinner'))
    await act(async () => { await result.current.send('maya', 'Maya') })
    expect(writeText).toHaveBeenCalledWith(`Dinner: your share\n${localUrl()}`)
    expect(mocks.toast).toHaveBeenCalledWith('Link copied')
  })

  it('keeps both message and URL for manual copying when clipboard is denied', async () => {
    writeText.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'))
    const { result } = renderHook(() => useSendLink('bill', 'Dinner'))
    await act(async () => { await result.current.send('maya', 'Maya') })
    expect(result.current.manual).toBe(`Dinner: your share\n${localUrl()}`)
    expect(mocks.toast).not.toHaveBeenCalled()
    act(() => result.current.closeManual())
    expect(result.current.manual).toBeNull()
  })

  it('does not report cancellation as failure or copy after native cancellation', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError'))
    vi.stubGlobal('navigator', { share, clipboard: { writeText } })
    const { result } = renderHook(() => useSendLink('bill', 'Dinner'))
    await act(async () => { await result.current.send('maya', 'Maya') })
    expect(writeText).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(result.current.manual).toBeNull()
    expect(result.current.busy).toBeNull()
  })

  it('falls back to copying after a non-cancellation native share failure', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('Activation expired', 'NotAllowedError'))
    vi.stubGlobal('navigator', { share, clipboard: { writeText } })
    const { result } = renderHook(() => useSendLink('bill', 'Dinner'))
    await act(async () => { await result.current.send('maya', 'Maya') })
    expect(writeText).toHaveBeenCalledWith(`Dinner: your share\n${localUrl()}`)
  })

  it('prefers the backend public URL outside dev auth', async () => {
    mocks.env.authMode = 'supabase'
    mocks.create.mockResolvedValue({ url: `https://even.example${path}`, path })
    const { result } = renderHook(() => useSendLink('bill', 'Dinner'))
    await act(async () => { await result.current.send(null) })
    expect(writeText).toHaveBeenCalledWith(`https://even.example${path}`)
  })

  it('resolves a relative production link against the current app origin', async () => {
    mocks.env.authMode = 'supabase'
    mocks.create.mockResolvedValue({ url: path, path })
    const { result } = renderHook(() => useSendLink('bill', 'Dinner'))
    await act(async () => { await result.current.send(null) })
    expect(writeText).toHaveBeenCalledWith(localUrl())
  })

  it('uses the same-origin path when the backend has no public URL', async () => {
    mocks.env.authMode = 'supabase'
    mocks.create.mockResolvedValue({ url: null, path })
    const { result } = renderHook(() => useSendLink('bill', 'Dinner'))
    await act(async () => { await result.current.send(null) })
    expect(writeText).toHaveBeenCalledWith(localUrl())
  })

  it('reuses an active token in this mount instead of creating duplicate links', async () => {
    const { result } = renderHook(() => useSendLink('bill', 'Dinner'))
    await act(async () => { await result.current.send('maya', 'Maya') })
    await act(async () => { await result.current.send('maya', 'Maya') })
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledTimes(2)
  })

  it.each(['revoked', 'expired', 'removed'])('replaces a %s link instead of sending it again', async (state) => {
    const { result } = renderHook(() => useSendLink('bill', 'Dinner'))
    await act(async () => { await result.current.send('maya', 'Maya') })
    records = state === 'removed' ? [] : records.map((row) => ({
      ...row,
      revoked_at: state === 'revoked' ? '2026-10-07T12:00:00Z' : null,
      expires_at: state === 'expired' ? '2000-01-01T00:00:00Z' : null,
    }))
    await act(async () => { await result.current.send('maya', 'Maya') })
    expect(mocks.create).toHaveBeenCalledTimes(2)
  })

  it('prevents concurrent sends from generating duplicates', async () => {
    const { result } = renderHook(() => useSendLink('bill', 'Dinner'))
    await act(async () => {
      await Promise.all([result.current.send('maya', 'Maya'), result.current.send('maya', 'Maya')])
    })
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('checks batch capacity before creating anything', async () => {
    records = Array.from({ length: 49 }, (_, index) => record(`existing-${index}`))
    const { result } = renderHook(() => useSendLink('bill', 'Dinner'))
    await act(async () => { await result.current.sendAll([{ id: 'maya', name: 'Maya' }, { id: 'tom', name: 'Tom' }]) })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('Revoke links below'), 'danger')
  })

  it('accounts for expired links still occupying the backend cap', async () => {
    records = Array.from({ length: 50 }, (_, index) => ({ ...record(`existing-${index}`), expires_at: '2000-01-01T00:00:00Z' }))
    const { result } = renderHook(() => useSendLink('bill', 'Dinner'))
    await act(async () => { await result.current.send('maya', 'Maya') })
    expect(mocks.create).not.toHaveBeenCalled()
    records = records.map((row) => ({ ...row, revoked_at: '2026-10-07T12:00:00Z' }))
    await act(async () => { await result.current.send('maya', 'Maya') })
    expect(mocks.create).toHaveBeenCalledTimes(1)
  })

  it('reports a server-side cap race with actionable feedback', async () => {
    mocks.create.mockRejectedValue(new ApiError(400, 'too_many_links', 'Revoke some links on this bill first.'))
    const { result } = renderHook(() => useSendLink('bill', 'Dinner'))
    await act(async () => { await result.current.send('maya', 'Maya') })
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('50-link limit reached'), 'danger')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('reuses successful links when retrying a partially failed batch', async () => {
    const create = mocks.create.getMockImplementation()
    if (!create) throw new Error('Missing create fixture')
    mocks.create.mockImplementationOnce(create).mockRejectedValueOnce(new ApiError(503, 'offline', 'Try again.'))
    const { result } = renderHook(() => useSendLink('bill', 'Dinner'))
    const people = [{ id: 'maya', name: 'Maya' }, { id: 'tom', name: 'Tom' }]
    await act(async () => { await result.current.sendAll(people) })
    expect(writeText).not.toHaveBeenCalled()
    await act(async () => { await result.current.sendAll(people) })
    expect(mocks.create.mock.calls.filter(([body]) => body.person_id === 'maya')).toHaveLength(1)
    expect(mocks.create.mock.calls.filter(([body]) => body.person_id === 'tom')).toHaveLength(2)
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining(`Maya: ${localUrl()}\nTom: ${localUrl()}`))
  })

  it('does not deliver cached tokens when metadata cannot be refreshed', async () => {
    const { result } = renderHook(() => useSendLink('bill', 'Dinner'))
    await act(async () => { await result.current.send('maya', 'Maya') })
    mocks.refetch.mockRejectedValue(new ApiError(503, 'offline', 'Try again.'))
    await act(async () => { await result.current.send('maya', 'Maya') })
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(mocks.toast).toHaveBeenLastCalledWith('Try again.', 'danger')
  })

  it('forgets revoked tokens and clears manual fallback', async () => {
    writeText.mockRejectedValue(new Error('Denied'))
    const { result } = renderHook(() => useSendLink('bill', 'Dinner'))
    await act(async () => { await result.current.send('maya', 'Maya') })
    act(() => result.current.forget('link-maya'))
    expect(result.current.manual).toBeNull()
    await act(async () => { await result.current.send('maya', 'Maya') })
    expect(mocks.create).toHaveBeenCalledTimes(2)
  })

  it('does not carry cached tokens into another bill', async () => {
    const { result, rerender } = renderHook(({ id }) => useSendLink(id, 'Dinner'), { initialProps: { id: 'bill' } })
    await act(async () => { await result.current.send('maya', 'Maya') })
    rerender({ id: 'another-bill' })
    await act(async () => { await result.current.send('maya', 'Maya') })
    expect(mocks.create).toHaveBeenCalledTimes(2)
  })
})