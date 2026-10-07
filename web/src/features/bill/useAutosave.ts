import { useEffect, useState, useSyncExternalStore } from 'react'

interface Snapshot {
  dirty: boolean
  saving: boolean
  error: unknown
}

/** The engine, outside React: latest value wins, one request at a time, failures keep the value. */
class Saver<T, R> {
  save: (value: T) => Promise<R> = () => Promise.reject(new Error('not ready'))
  onSaved?: (result: R, value: T) => void
  delay = 600
  private pending: { value: T } | null = null
  private inflight = false
  private failed = false
  private timer: number | undefined
  private waiters: Array<(ok: boolean) => void> = []
  private listeners = new Set<() => void>()
  private snap: Snapshot = { dirty: false, saving: false, error: null }

  configure(save: (value: T) => Promise<R>, delay: number, onSaved?: (result: R, value: T) => void) {
    this.save = save
    this.delay = delay
    this.onSaved = onSaved
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  getSnapshot = () => this.snap

  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch }
    this.listeners.forEach((l) => l())
  }

  private settle(ok: boolean) {
    const w = this.waiters
    this.waiters = []
    w.forEach((fn) => fn(ok))
  }

  private run = () => {
    window.clearTimeout(this.timer)
    if (this.inflight || !this.pending) return
    const { value } = this.pending
    this.pending = null
    this.inflight = true
    this.set({ saving: true })
    this.save(value)
      .then((result) => {
        this.failed = false
        this.onSaved?.(result, value)
      })
      .catch((error: unknown) => {
        this.failed = true
        if (!this.pending) this.pending = { value } // keep it for retry unless something newer is queued
        this.set({ error })
      })
      .finally(() => {
        this.inflight = false
        if (this.pending && !this.failed) return this.run()
        this.set({ dirty: Boolean(this.pending), saving: false, ...(this.failed ? {} : { error: null }) })
        this.settle(!this.failed)
      })
  }

  schedule(value: T) {
    this.pending = { value }
    this.failed = false
    if (!this.snap.dirty || this.snap.error !== null) this.set({ dirty: true, error: null })
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(this.run, this.delay)
  }

  flush(): Promise<boolean> {
    if (!this.pending && !this.inflight) return Promise.resolve(!this.failed)
    this.failed = false
    const done = new Promise<boolean>((resolve) => this.waiters.push(resolve))
    this.run()
    return done
  }

  retry() {
    this.failed = false
    this.set({ error: null })
    this.run()
  }

  /** Leaving the screen: send what's pending now; the mutation outlives the component. */
  dispose() {
    window.clearTimeout(this.timer)
    if (!this.failed) this.run()
  }
}

/**
 * Debounced, strictly serial autosave.
 * - schedule(v) saves `v` after `delay` ms of quiet (each call restarts the clock)
 * - flush() saves now and resolves true once everything is saved (false if a save failed)
 * - a failed save keeps the value; retry() sends it again
 * - cleanup sends pending work through the same queue; navigation must await flush()
 */
export function useAutosave<T, R>(save: (value: T) => Promise<R>, opts: { delay: number; onSaved?: (result: R, value: T) => void }) {
  const [saver] = useState(() => new Saver<T, R>())
  useEffect(() => saver.configure(save, opts.delay, opts.onSaved))
  useEffect(() => () => saver.dispose(), [saver])
  const state = useSyncExternalStore(saver.subscribe, saver.getSnapshot)

  useEffect(() => {
    if (!state.dirty && !state.saving) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [state.dirty, state.saving])

  return {
    schedule: (v: T) => saver.schedule(v),
    flush: () => saver.flush(),
    retry: () => saver.retry(),
    dirty: state.dirty,
    saving: state.saving,
    error: state.error,
  }
}
