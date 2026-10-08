import { createElement } from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import * as apiModule from '@/lib/api'
import type { AdminUserOut } from '@/lib/types'
import { EditUserDialog } from './Accounts'
import { emailError, formatUsd, microsToUsdInput, normaliseUsername, parseCount, parseUsdToMicros, usernameError, userTags } from './logic'

const accountMocks = vi.hoisted(() => ({
  remove: vi.fn(), update: vi.fn(), reset: vi.fn(), toast: vi.fn(),
  pending: false, currentId: 'root',
}))

vi.mock('@/data/queries', () => ({
  useMe: () => ({ data: { id: accountMocks.currentId } }),
  useDeleteAdminUser: () => ({ mutateAsync: accountMocks.remove, isPending: accountMocks.pending }),
  useUpdateUser: () => ({ mutateAsync: accountMocks.update, isPending: false }),
  useResetPassword: () => ({ mutateAsync: accountMocks.reset, isPending: false }),
}))
vi.mock('@/components/Feedback', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/components/Feedback')>(),
  useToast: () => accountMocks.toast,
}))

afterEach(() => { cleanup() })

describe('admin account deletion confirmation', () => {
  const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
  beforeAll(() => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) { this.open = true },
    })
  })
  afterAll(() => {
    if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  })
  const user: AdminUserOut = {
    id: 'mei-id', username: 'mei', email: null, display_name: 'Mei', role: 'member',
    must_change_password: false, monthly_scan_quota: 30, disabled_at: null,
    created_at: '', pages_used_this_month: 2,
  }
  beforeEach(() => {
    vi.clearAllMocks()
    accountMocks.pending = false
    accountMocks.currentId = 'root'
    accountMocks.remove.mockReset()
    accountMocks.remove.mockResolvedValue(undefined)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('requires the exact username and explains all deletion consequences', async () => {
    const close = vi.fn()
    render(createElement(EditUserDialog, { user, onClose: close }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    expect(screen.getByText(/Permanently deletes their bills and saved people/)).toHaveTextContent(/revokes share links.*removes receipt photos.*removes their login/)
    expect(screen.getByText(/Usage quota history remains anonymous/)).toHaveTextContent(/Azure and OpenAI/)
    const confirm = screen.getByRole('button', { name: 'Delete account' })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Confirm username'), { target: { value: 'MEI' } })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Confirm username'), { target: { value: 'mei' } })
    expect(confirm).toBeEnabled()
    expect(confirm.className).toContain('h-11')
    fireEvent.click(confirm)
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(accountMocks.remove).toHaveBeenCalledExactlyOnceWith('mei-id')
    expect(accountMocks.toast).toHaveBeenCalledWith('@mei deleted')
  })

  it('does not offer self deletion', () => {
    accountMocks.currentId = user.id
    render(createElement(EditUserDialog, { user, onClose: vi.fn() }))
    expect(screen.queryByRole('button', { name: 'Delete account' })).not.toBeInTheDocument()
    expect(screen.getByText('You cannot delete your own account.')).toBeVisible()
  })

  it('cancels without sending a deletion', () => {
    render(createElement(EditUserDialog, { user, onClose: vi.fn() }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('heading', { name: 'Edit Mei' })).toBeVisible()
    expect(accountMocks.remove).not.toHaveBeenCalled()
  })

  it('keeps confirmation and permits retry after a cleanup error', async () => {
    const close = vi.fn()
    accountMocks.remove.mockRejectedValueOnce(new ApiError(503, 'account_cleanup_pending', 'Receipt cleanup failed. Retry account deletion.'))
    render(createElement(EditUserDialog, { user, onClose: close }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    fireEvent.change(screen.getByLabelText('Confirm username'), { target: { value: 'mei' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    await screen.findByText('Receipt cleanup failed. Retry account deletion.')
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Confirm username')).toHaveValue('mei')
    fireEvent.click(screen.getByRole('button', { name: 'Retry delete account' }))
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(accountMocks.remove).toHaveBeenCalledTimes(2)
  })

  it('blocks duplicate clicks, cancellation and dismissal while pending', () => {
    const close = vi.fn()
    const view = render(createElement(EditUserDialog, { user, onClose: close }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    fireEvent.change(screen.getByLabelText('Confirm username'), { target: { value: 'mei' } })
    accountMocks.pending = true
    view.rerender(createElement(EditUserDialog, { user, onClose: close }))
    expect(screen.getByRole('button', { name: 'Delete account' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete account' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.getByRole('heading', { name: 'Delete @mei?' })).toBeVisible()
    expect(close).not.toHaveBeenCalled()
    expect(accountMocks.remove).not.toHaveBeenCalled()
  })
})

describe('admin deletion query hook', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it.each([false, true])('invalidates accounts and all usage months after deletion (failure: %s)', async (failure) => {
    const queries = await vi.importActual<typeof import('@/data/queries')>('@/data/queries')
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const api = vi.spyOn(apiModule, 'api')
    if (failure) api.mockRejectedValue(new ApiError(503, 'account_cleanup_pending', 'Retry deletion.'))
    else api.mockResolvedValue(undefined)
    client.setQueryData(queries.qk.adminUsers, { items: [] })
    client.setQueryData(queries.qk.adminUsage(), { totals: {} })
    client.setQueryData(queries.qk.adminUsage('2026-09'), { totals: {} })
    const wrapper = ({ children }: { children: React.ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const { result } = renderHook(() => queries.useDeleteAdminUser(), { wrapper })
    await act(async () => {
      try {
        await result.current.mutateAsync('mei-id')
        expect(failure).toBe(false)
      } catch (err) {
        expect(failure).toBe(true)
        expect(err).toBeInstanceOf(ApiError)
      }
    })
    expect(api).toHaveBeenCalledExactlyOnceWith('/admin/users/mei-id', { method: 'DELETE' })
    expect(client.getQueryState(queries.qk.adminUsers)?.isInvalidated).toBe(true)
    expect(client.getQueryState(queries.qk.adminUsage())?.isInvalidated).toBe(true)
    expect(client.getQueryState(queries.qk.adminUsage('2026-09'))?.isInvalidated).toBe(true)
    client.clear()
  })
})

describe('usernames', () => {
  it('lower-cases as typed and drops spaces', () => {
    expect(normaliseUsername('Mei Ling')).toBe('meiling')
    expect(normaliseUsername('GEORGE.P')).toBe('george.p')
  })
  it('validates length and characters', () => {
    expect(usernameError('ab')).toMatch(/3/)
    expect(usernameError('a'.repeat(33))).toMatch(/32/)
    expect(usernameError('_mei')).toMatch(/start/)
    expect(usernameError('mei!')).toMatch(/Letters/)
    expect(usernameError('mei_ling-2.x')).toBeNull()
  })
  it('checks Google emails loosely', () => {
    expect(emailError('mei@gmail.com')).toBeNull()
    expect(emailError('mei@')).not.toBeNull()
  })
})

describe('numbers and money', () => {
  it('parses whole counts in range', () => {
    expect(parseCount('30', 0, 10000)).toBe(30)
    expect(parseCount(' 0 ', 0, 10)).toBe(0)
    expect(parseCount('3.5', 0, 10)).toBeNull()
    expect(parseCount('11', 0, 10)).toBeNull()
    expect(parseCount('', 0, 10)).toBeNull()
  })
  it('formats micros as dollars', () => {
    expect(formatUsd(1_820_000)).toBe('$1.82')
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(1_200)).toBe('< $0.01')
    expect(formatUsd(1_234_560_000)).toBe('$1,234.56')
  })
  it('parses dollar input to micros', () => {
    expect(parseUsdToMicros('8')).toBe(8_000_000)
    expect(parseUsdToMicros('$8.5')).toBe(8_500_000)
    expect(parseUsdToMicros('1,000.25')).toBe(1_000_250_000)
    expect(parseUsdToMicros('8.505')).toBeNull()
    expect(parseUsdToMicros('-1')).toBeNull()
    expect(parseUsdToMicros('')).toBeNull()
    expect(microsToUsdInput(8_000_000)).toBe('8.00')
  })
})

describe('userTags', () => {
  const base: AdminUserOut = {
    id: '1',
    username: 'mei',
    email: null,
    display_name: 'Mei',
    role: 'member',
    must_change_password: false,
    monthly_scan_quota: 30,
    disabled_at: null,
    created_at: '',
    pages_used_this_month: 2,
  }
  it('says Member when nothing stands out', () => {
    expect(userTags(base)).toEqual([{ label: 'Member', tone: 'quiet' }])
  })
  it('lists every state that matters, disabled first', () => {
    const tags = userTags({ ...base, role: 'admin', must_change_password: true, disabled_at: 'x' }).map((t) => t.label)
    expect(tags).toEqual(['Disabled', 'Admin', 'Must change password'])
    expect(userTags({ ...base, pages_used_this_month: 30 }).map((t) => t.label)).toEqual(['At limit'])
  })
})
