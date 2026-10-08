import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FlowShell } from '@/app/FlowShell'
import { QuickForm } from './QuickForm'
import { useAutosave } from './useAutosave'

const { quickSave } = vi.hoisted(() => ({ quickSave: vi.fn<() => Promise<{ id: string }>>() }))
vi.mock('@/data/queries', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/data/queries')>(),
  useMe: () => ({ data: { default_currency: 'SGD', self_person_id: 'me' } }),
  usePeople: () => ({ data: [
    { id: 'me', name: 'Owner', color_seed: 0, is_self: true },
    { id: 'maya', name: 'Maya', color_seed: 1, is_self: false },
  ] }),
  useQuickSplit: () => useMutation({ mutationFn: quickSave, retry: false }),
}))

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useAutosave', () => {
  it('debounces to the latest value and saves once', async () => {
    const save = vi.fn(async (v: number) => v)
    const { result } = renderHook(() => useAutosave(save, { delay: 500 }))
    act(() => {
      result.current.schedule(1)
      result.current.schedule(2)
    })
    expect(result.current.dirty).toBe(true)
    expect(result.current.saving).toBe(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(2)
    expect(result.current.dirty).toBe(false)
  })

  it('keeps saves serial and sends what arrived meanwhile', async () => {
    let release!: () => void
    const save = vi.fn((v: number) => (v === 1 ? new Promise<number>((r) => (release = () => r(v))) : Promise.resolve(v)))
    const { result } = renderHook(() => useAutosave(save, { delay: 100 }))
    act(() => result.current.schedule(1))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    act(() => result.current.schedule(2))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(save).toHaveBeenCalledTimes(1) // still waiting on the first
    let flushed: boolean | undefined
    await act(async () => {
      void result.current.flush().then((ok) => (flushed = ok))
      release()
      await vi.runAllTimersAsync()
    })
    expect(save.mock.calls.map((c) => c[0])).toEqual([1, 2])
    expect(flushed).toBe(true)
  })

  it('keeps a failed value for retry and reports it', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('ok')
    const onSaved = vi.fn()
    const { result } = renderHook(() => useAutosave(save, { delay: 10, onSaved }))
    let ok: boolean | undefined
    await act(async () => {
      result.current.schedule('draft')
      ok = await result.current.flush()
    })
    expect(ok).toBe(false)
    expect(result.current.error).toBeInstanceOf(Error)
    await act(async () => {
      result.current.retry()
      await vi.runAllTimersAsync()
    })
    expect(save).toHaveBeenLastCalledWith('draft')
    expect(onSaved).toHaveBeenCalledWith('ok', 'draft')
    expect(result.current.error).toBeNull()
  })

  it('tracks cleanup saves and retains a failed value for retry', async () => {
    let reject!: (error: Error) => void
    const save = vi.fn()
      .mockImplementationOnce(() => new Promise((_, rejectSave) => { reject = rejectSave }))
      .mockResolvedValue('ok')
    const { result, unmount } = renderHook(() => useAutosave(save, { delay: 500 }))
    act(() => result.current.schedule('draft'))
    const saver = result.current
    unmount()
    expect(save).toHaveBeenCalledWith('draft')
    const flushed = saver.flush()
    reject(new Error('offline'))
    expect(await flushed).toBe(false)
    expect(await saver.flush()).toBe(true)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith('draft')
  })
})

function renderEditor(saveValue: (value: string) => Promise<string>) {
  function Editor() {
    const save = useAutosave(saveValue, { delay: 600 })
    return createElement(FlowShell, { billId: 'bill', steps: ['People'], current: 0, save,
      children: createElement('button', { onClick: () => save.schedule('draft') }, 'Edit'),
    })
  }
  return renderFlow(createElement(Editor))
}

function renderFlow(editor: ReactNode) {
  const router = createMemoryRouter([
    { path: '/', element: createElement('h1', null, 'Home') },
    { path: '/edit', element: editor },
    { path: '/bills/:billId', element: createElement('h1', null, 'Totals') },
  ], { initialEntries: ['/', '/edit'] })
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(createElement(QueryClientProvider, { client: qc }, createElement(RouterProvider, { router })))
  return { router, qc }
}

describe('FlowShell safe exit', () => {
  it('shows dirty during debounce and waits for exit saving to finish', async () => {
    let release!: () => void
    const save = vi.fn(() => new Promise<string>((resolve) => { release = () => resolve('ok') }))
    const { router } = renderEditor(save)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getAllByText(/Unsaved changes/)).toHaveLength(2)
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    expect(save).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save & exit' })))
    expect(save).toHaveBeenCalledWith('draft')
    expect(router.state.location.pathname).toBe('/edit')
    expect(screen.getByRole('button', { name: 'Save & exit' })).toBeDisabled()
    await act(async () => { release() })
    expect(router.state.location.pathname).toBe('/')
  })

  it('stays on failed exit, shows not saved, and retries the retained draft', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('ok')
    const { router } = renderEditor(save)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save & exit' })))
    expect(router.state.location.pathname).toBe('/edit')
    expect(screen.getAllByText(/Not saved/)).toHaveLength(2)
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry exit' })))
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith('draft')
    expect(router.state.location.pathname).toBe('/')
  })

  it('holds browser Back on failure and warns before unloading unsaved work', async () => {
    const save = vi.fn().mockRejectedValue(new Error('offline'))
    const { router } = renderEditor(save)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await act(async () => { await router.navigate(-1) })
    expect(save).toHaveBeenCalledWith('draft')
    expect(router.state.location.pathname).toBe('/edit')
    expect(screen.getByRole('button', { name: 'Retry exit' })).toBeInTheDocument()
  })

  it.each([false, true])('waits for other pending bill saves and handles failure=%s', async (fails) => {
    let finish!: () => void
    const { router, qc } = renderEditor(vi.fn().mockResolvedValue('ok'))
    const mutation = qc.getMutationCache().build(qc, {
      mutationKey: ['bill', 'bill'],
      mutationFn: () => new Promise<void>((resolve, reject) => {
        finish = () => fails ? reject(new Error('offline')) : resolve()
      }),
    })
    let completed!: Promise<unknown>
    await act(async () => {
      completed = mutation.execute(undefined).catch(() => undefined)
      await vi.advanceTimersByTimeAsync(0)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save & exit' })))
    expect(router.state.location.pathname).toBe('/edit')
    await act(async () => { finish(); await completed })
    expect(router.state.location.pathname).toBe(fails ? '/edit' : '/')
    if (fails) expect(screen.getByRole('button', { name: 'Retry exit' })).toBeInTheDocument()
  })
})

describe('QuickForm safe exit', () => {
  beforeEach(() => { quickSave.mockReset() })

  it('exits an untouched form without creating a bill', async () => {
    const { router } = renderFlow(createElement(QuickForm))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Exit' })))
    expect(router.state.location.pathname).toBe('/')
    expect(quickSave).not.toHaveBeenCalled()
  })

  it('keeps edited fields on exit and Back instead of claiming they were saved', async () => {
    const { router } = renderFlow(createElement(QuickForm))
    fireEvent.change(screen.getByRole('textbox', { name: 'What was it?' }), { target: { value: 'Lunch' } })
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    expect(screen.getAllByText(/Unsaved changes/)).toHaveLength(2)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Exit' })))
    expect(router.state.location.pathname).toBe('/edit')
    expect(screen.getByText('Use Split it to save your changes.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'What was it?' })).toHaveValue('Lunch')
    await act(async () => { await router.navigate(-1) })
    expect(router.state.location.pathname).toBe('/edit')
    expect(quickSave).not.toHaveBeenCalled()
  })

  it('awaits a submitted split and exits to the requested destination', async () => {
    let release!: () => void
    quickSave.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ id: 'quick' }) }))
    const { router } = renderFlow(createElement(QuickForm))
    fireEvent.change(screen.getByLabelText('Total'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Maya' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Split it' })))
    expect(quickSave).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Total')).toBeDisabled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Exit' })))
    await act(async () => { await vi.advanceTimersByTimeAsync(7000) })
    expect(router.state.location.pathname).toBe('/edit')
    await act(async () => { release() })
    expect(router.state.location.pathname).toBe('/')
  })

  it('retains edits after a failed submitted exit and allows an explicit split retry', async () => {
    let reject!: (error: Error) => void
    quickSave.mockImplementationOnce(() => new Promise((_, rejectSave) => { reject = rejectSave }))
      .mockResolvedValue({ id: 'quick' })
    const { router } = renderFlow(createElement(QuickForm))
    fireEvent.change(screen.getByLabelText('Total'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Maya' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Split it' })))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Exit' })))
    await act(async () => { reject(new Error('offline')) })
    expect(router.state.location.pathname).toBe('/edit')
    expect(screen.getByLabelText('Total')).toHaveValue('30')
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Split it' })))
    expect(quickSave).toHaveBeenCalledTimes(2)
    expect(router.state.location.pathname).toBe('/bills/quick')
  })
})
