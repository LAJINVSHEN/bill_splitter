import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api, ApiError, newIdempotencyKey } from '@/lib/api'
import type {
  AccessRequestOut,
  AdminSettingsOut,
  AdminUsageOut,
  AdminUserOut,
  BillOut,
  BillStatus,
  BillSummaryOut,
  FriendsOut,
  FxRateOut,
  GroupOut,
  JobOut,
  MailboxOut,
  JobStatus,
  MeOut,
  Page,
  PersonOut,
  PublicShareOut,
  SettlePiece,
  SettleUpOut,
  RecordView,
  EnsuredLink,
  InboxClaim,
  SplitMode,
  SummaryOut,
  UsageOut,
  UUID,
} from '@/lib/types'

/** Query keys: one place, so invalidation is exhaustive. */
export const qk = {
  me: ['me'] as const,
  usage: ['me', 'usage'] as const,
  summary: ['me', 'summary'] as const,
  fxRates: ['me', 'fx-rates'] as const,
  people: ['people'] as const,
  bills: (statuses?: string) => ['bills', statuses ?? 'all'] as const,
  billsAll: ['bills'] as const,
  bill: (id: UUID) => ['bill', id] as const,
  job: (id: UUID) => ['job', id] as const,
  adminUsers: ['admin', 'users'] as const,
  adminUsage: (month?: string) => ['admin', 'usage', month ?? 'current'] as const,
  adminSettings: ['admin', 'settings'] as const,
  publicShare: (token: string) => ['public-share', token] as const,
  inbox: ['me', 'claims'] as const,
  // under `summary`, so everything that refreshes balances refreshes the plan too
  settleUp: (combine: string | null, groupId?: UUID | null) =>
    ['me', 'summary', 'settle-up', combine ?? 'apart', groupId ?? 'everyone'] as const,
  friends: ['friends'] as const,
  mailbox: ['mailbox'] as const,
  groups: ['groups'] as const,
  accessRequests: ['admin', 'access-requests'] as const,
}

const TERMINAL: JobStatus[] = ['succeeded', 'needs_review', 'failed', 'cancelled']
export const isJobActive = (s: JobStatus | undefined | null) => Boolean(s) && !TERMINAL.includes(s as JobStatus)

// ---- me ----------------------------------------------------------------------------------------
export const useMe = (enabled = true) => useQuery({ queryKey: qk.me, queryFn: () => api<MeOut>('/me'), enabled, staleTime: 60_000 })
export const useUsage = () => useQuery({ queryKey: qk.usage, queryFn: () => api<UsageOut>('/me/usage') })
export const useSummary = () => useQuery({ queryKey: qk.summary, queryFn: () => api<SummaryOut>('/me/summary') })

// ---- settle up ---------------------------------------------------------------------------------
/** Open debts across bills: as the bills say and as the fewest payments. `combine` merges currencies;
 * `groupId` narrows it to one of your groups (accounts simplified, placeholders apart). */
export const useSettleUp = (combine: string | null, groupId: UUID | null = null, enabled = true) =>
  useQuery({
    queryKey: qk.settleUp(combine, groupId),
    queryFn: () => {
      const params = new URLSearchParams()
      if (combine) params.set('combine', combine)
      if (groupId) params.set('group_id', groupId)
      return api<SettleUpOut>(`/me/settle-up${params.size ? `?${params}` : ''}`)
    },
    placeholderData: keepPreviousData,
    enabled,
  })

export interface SettleRecord {
  view: RecordView
  combine: string | null
  group_id?: UUID | null
  currency: string
  from_person_id?: UUID
  to_person_id?: UUID
  amount_cents?: number
}

/** Mark one row paid. It writes settlements on bills, so everything derived from bills refreshes. */
export function useRecordSettleUp() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.summary })
    void qc.invalidateQueries({ queryKey: qk.billsAll })
    void qc.invalidateQueries({ queryKey: ['bill'] })
  }
  return useMutation({
    mutationFn: (body: SettleRecord) => api<SettleUpOut>('/me/settle-up/payments', { method: 'POST', body }),
    onSuccess: (out, body) => {
      qc.setQueryData(qk.settleUp(body.combine, body.group_id), out)
      refresh()
    },
    onError: refresh, // a stale plan (409) re-fetches the latest
  })
}

/** Take back a recorded row: subtracts exactly the pieces it marked paid. */
export function useUndoSettleUp() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.summary })
    void qc.invalidateQueries({ queryKey: qk.billsAll })
    void qc.invalidateQueries({ queryKey: ['bill'] })
  }
  return useMutation({
    mutationFn: (body: { combine: string | null; group_id?: UUID | null; pieces: SettlePiece[] }) =>
      api<SettleUpOut>('/me/settle-up/undo', { method: 'POST', body }),
    onSuccess: (out, body) => {
      qc.setQueryData(qk.settleUp(body.combine, body.group_id), out)
      refresh()
    },
    onError: refresh,
  })
}

export function useUpdateMe() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { display_name?: string; default_currency?: string; payment_note?: string | null; discoverable?: boolean }) =>
      api<MeOut>('/me', { method: 'PATCH', body }),
    onSuccess: (me) => {
      qc.setQueryData(qk.me, me)
      void qc.invalidateQueries({ queryKey: qk.summary })
    },
  })
}

export function usePasswordChanged() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<MeOut>('/me/password-changed', { method: 'POST' }),
    onSuccess: (me) => qc.setQueryData(qk.me, me),
  })
}

// ---- fx rates ------------------------------------------------------------------------------------
export const useFxRates = () =>
  useQuery({ queryKey: qk.fxRates, queryFn: async () => (await api<{ items: FxRateOut[] }>('/me/fx-rates')).items })

export function useSaveFxRate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ base, quote, rate }: { base: string; quote: string; rate: string }) =>
      api<FxRateOut>(`/me/fx-rates/${base}/${quote}`, { method: 'PUT', body: { rate } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.fxRates }),
  })
}

export function useDeleteFxRate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ base, quote }: { base: string; quote: string }) => api<void>(`/me/fx-rates/${base}/${quote}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.fxRates }),
  })
}

// ---- people --------------------------------------------------------------------------------------
export const usePeople = () =>
  useQuery({ queryKey: qk.people, queryFn: async () => (await api<{ items: PersonOut[] }>('/people')).items })

export function useCreatePerson() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { name: string; color_seed?: number }) => api<PersonOut>('/people', { method: 'POST', body }),
    onSuccess: (p) => qc.setQueryData<PersonOut[]>(qk.people, (old) => (old ? [...old, p] : [p])),
  })
}

export function useUpdatePerson() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: { id: UUID; name?: string; color_seed?: number; archived?: boolean }) =>
      api<PersonOut>(`/people/${id}`, { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.people }),
  })
}

export function useDeletePerson() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => api<void>(`/people/${id}?permanent=true`, { method: 'DELETE' }),
    onSuccess: async () => {
      await qc.cancelQueries({ queryKey: qk.people })
      await qc.invalidateQueries({ queryKey: qk.people })
    },
  })
}

export function useClearPeople() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ permanent = true }: { permanent?: boolean }) =>
      api<void>(`/people?permanent=${permanent}&confirmation=DELETE%20ALL%20PEOPLE`, { method: 'DELETE' }),
    onSuccess: async () => {
      await qc.cancelQueries({ queryKey: qk.people })
      await qc.invalidateQueries({ queryKey: qk.people })
    },
  })
}

// ---- bills ---------------------------------------------------------------------------------------
export function useBills(statuses?: BillStatus[], limit = 20, settled?: boolean) {
  const key = statuses?.join(',')
  return useInfiniteQuery({
    queryKey: [...qk.bills(key), limit, settled ?? null],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(limit) })
      if (key) params.set('status', key)
      if (settled !== undefined) params.set('settled', String(settled))
      if (pageParam) params.set('cursor', pageParam)
      return api<Page<BillSummaryOut>>(`/bills?${params}`)
    },
    getNextPageParam: (last) => last.next_cursor,
    placeholderData: keepPreviousData,
  })
}

export const useBill = (id: UUID | undefined) =>
  useQuery({
    queryKey: qk.bill(id ?? ''),
    queryFn: () => api<BillOut>(`/bills/${id}`),
    enabled: Boolean(id),
    // while a scan runs, keep the bill fresh too (status/items flip when the job ends)
    refetchInterval: (q) => (q.state.data?.status === 'scanning' ? 2000 : false),
  })

/** Write a returned BillOut into the cache and refresh everything derived from bills. */
export function applyBill(qc: QueryClient, bill: BillOut) {
  qc.setQueryData(qk.bill(bill.id), bill)
  void qc.invalidateQueries({ queryKey: qk.billsAll })
  void qc.invalidateQueries({ queryKey: qk.summary })
}

function useBillMutation<V>(billId: UUID, fn: (vars: V) => Promise<BillOut>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (bill) => applyBill(qc, bill),
    // someone else changed the same thing: fetch the latest so the screen can show it
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'bill_changed') void qc.invalidateQueries({ queryKey: qk.bill(billId), exact: true })
    },
    mutationKey: ['bill', billId],
  })
}

/** The version this screen edited from; a save from an older one is checked for clashes. */
function versionHeader(qc: QueryClient, billId: UUID): Record<string, string> {
  const version = qc.getQueryData<BillOut>(qk.bill(billId))?.version
  return version ? { 'X-Bill-Version': String(version) } : {}
}

/** "Ben changed this while you were editing": the save was refused, the latest is being fetched. */
export const isBillChanged = (err: unknown) => err instanceof ApiError && err.code === 'bill_changed'

export function useCreateBill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { title?: string; merchant?: string; bill_date?: string; currency?: string; source?: 'manual' | 'scan' | 'quick' }) =>
      api<BillOut>('/bills', { method: 'POST', body }),
    onSuccess: (bill) => applyBill(qc, bill),
  })
}

export interface BillPatch {
  title?: string | null
  merchant?: string | null
  bill_date?: string | null
  currency?: string
  status?: 'draft' | 'review' | 'assigning' | 'complete'
  payer_person_id?: UUID | null
  settle_currency?: string | null
  fx_rate?: string | null
  save_rate?: boolean
}
export const usePatchBill = (billId: UUID) =>
  useBillMutation(billId, (body: BillPatch) => api<BillOut>(`/bills/${billId}`, { method: 'PATCH', body }))

/** Deleting a bill is always permanent, wherever it starts (Summary, Bills history). */
export function useDeleteBill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (billId: UUID) => api<void>(`/bills/${billId}?permanent=true`, { method: 'DELETE' }),
    onSuccess: async (_v, billId) => {
      await qc.cancelQueries({ queryKey: qk.bill(billId) })
      qc.removeQueries({ queryKey: qk.bill(billId) })
      await qc.cancelQueries({ queryKey: ['job'] })
      qc.removeQueries({ queryKey: ['job'] })
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.billsAll }),
        qc.invalidateQueries({ queryKey: qk.summary }),
        qc.invalidateQueries({ queryKey: qk.usage }),
      ])
    },
  })
}

export function useClearBills() {
  const qc = useQueryClient()
  return useMutation({
    // every bill; there is deliberately no "bills of one person" variant
    mutationFn: ({ permanent = true }: { permanent?: boolean }) =>
      api<void>(`/bills?${new URLSearchParams({ permanent: String(permanent), confirmation: 'DELETE ALL BILLS' })}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await Promise.all([
        qc.cancelQueries({ queryKey: ['bill'] }),
        qc.cancelQueries({ queryKey: ['job'] }),
      ])
      qc.removeQueries({ queryKey: ['bill'] })
      qc.removeQueries({ queryKey: ['job'] })
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.billsAll }),
        qc.invalidateQueries({ queryKey: qk.summary }),
        qc.invalidateQueries({ queryKey: qk.usage }),
      ])
    },
  })
}

export interface ReceiptIn {
  items: Array<{ id?: UUID; name: string; quantity?: string; unit_price_cents: number; total_price_cents: number }>
  charges?: Array<{ name: string; amount_cents: number; kind?: string }>
  subtotal_cents?: number | null
  grand_total_cents: number
  merchant?: string | null
  bill_date?: string | null
}
export function usePutReceipt(billId: UUID) {
  const qc = useQueryClient()
  return useBillMutation(billId, (body: ReceiptIn) =>
    api<BillOut>(`/bills/${billId}/receipt`, { method: 'PUT', body, headers: versionHeader(qc, billId) }),
  )
}

export const usePutParticipants = (billId: UUID) =>
  useBillMutation(billId, (person_ids: UUID[]) => api<BillOut>(`/bills/${billId}/participants`, { method: 'PUT', body: { person_ids } }))

export interface AssignmentIn {
  item_id: UUID
  mode: SplitMode | null
  shares: Array<{ person_id: UUID; weight?: string; amount_cents?: number }>
}
export function usePutAssignments(billId: UUID) {
  const qc = useQueryClient()
  return useBillMutation(billId, (assignments: AssignmentIn[]) =>
    api<BillOut>(`/bills/${billId}/assignments`, { method: 'PUT', body: { assignments }, headers: versionHeader(qc, billId) }),
  )
}

export const usePutQuick = (billId: UUID) =>
  useBillMutation(
    billId,
    (body: { total_cents: number; mode?: 'equal' | 'shares'; participants: Array<{ person_id: UUID; weight?: string }>; title?: string }) =>
      api<BillOut>(`/bills/${billId}/quick`, { method: 'PUT', body }),
  )

export interface QuickSplitVars {
  /** omit to create the bill now (never an empty draft) */
  billId?: UUID
  currency: string
  /** the bill's currency before this save; a change relabels first */
  previousCurrency?: string
  total_cents: number
  mode: 'equal' | 'shares' | 'amounts'
  participants: Array<{ person_id: UUID; weight?: string; amount_cents?: number }>
  title?: string
  /** remember a freshly created bill so a retry continues it instead of making another */
  onCreated?: (billId: UUID) => void
}

/** Quick split in one action: (create) → (currency) → PUT /quick → complete. Returns the final bill. */
export function useQuickSplit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ billId, currency, previousCurrency, total_cents, mode, participants, title, onCreated }: QuickSplitVars) => {
      let id = billId
      if (!id) {
        id = (await api<BillOut>('/bills', { method: 'POST', body: { source: 'quick', currency, ...(title ? { title } : {}) } })).id
        onCreated?.(id)
      } else if (previousCurrency && previousCurrency !== currency) {
        await api<BillOut>(`/bills/${id}`, { method: 'PATCH', body: { currency } })
      }
      await api<BillOut>(`/bills/${id}/quick`, { method: 'PUT', body: { total_cents, mode, participants, ...(title ? { title } : {}) } })
      return api<BillOut>(`/bills/${id}`, { method: 'PATCH', body: { status: 'complete' } })
    },
    onSuccess: (bill) => applyBill(qc, bill),
  })
}

export const useSettle = (billId: UUID) =>
  useBillMutation(billId, ({ personId, amount_cents }: { personId: UUID; amount_cents?: number }) =>
    api<BillOut>(`/bills/${billId}/participants/${personId}/settlement`, {
      method: 'POST',
      body: amount_cents === undefined ? {} : { amount_cents },
    }),
  )

export const useUnsettle = (billId: UUID) =>
  useBillMutation(billId, (personId: UUID) => api<BillOut>(`/bills/${billId}/participants/${personId}/settlement`, { method: 'DELETE' }))

/** "I've paid" on a bill someone else keeps (signed in, so no link): they confirm it. */
export function useClaimMine(billId: UUID) {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['bill', billId],
    mutationFn: (paid: boolean) =>
      paid
        ? api<BillOut>(`/bills/${billId}/claims/mine`, { method: 'POST', body: { client_key: crypto.randomUUID() } })
        : api<BillOut>(`/bills/${billId}/claims/mine`, { method: 'DELETE' }),
    onSuccess: (bill) => applyBill(qc, bill),
  })
}

// ---- scans & jobs --------------------------------------------------------------------------------
export function useStartScan(billId: UUID) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ files, idempotencyKey }: { files: File[]; idempotencyKey?: string }) => {
      const form = new FormData()
      files.forEach((f) => form.append('files', f, f.name))
      return api<{ job_id: UUID; status: JobStatus; replayed: boolean }>(`/bills/${billId}/scans`, {
        method: 'POST',
        form,
        idempotencyKey: idempotencyKey ?? newIdempotencyKey('scan'),
        timeoutMs: 120_000,
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.bill(billId) })
      void qc.invalidateQueries({ queryKey: qk.usage })
    },
  })
}

/**
 * Like useStartScan, for when the bill is created in the same action (New bill → Start).
 * Pass the same idempotencyKey when retrying after a network error: the server replays, never double-bills.
 */
export function useUploadScan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ billId, files, idempotencyKey }: { billId: UUID; files: File[]; idempotencyKey: string }) => {
      const form = new FormData()
      files.forEach((f) => form.append('files', f, f.name))
      return api<{ job_id: UUID; status: JobStatus; replayed: boolean }>(`/bills/${billId}/scans`, {
        method: 'POST',
        form,
        idempotencyKey,
        timeoutMs: 120_000,
      })
    },
    onSuccess: (_r, { billId }) => {
      void qc.invalidateQueries({ queryKey: qk.bill(billId) })
      void qc.invalidateQueries({ queryKey: qk.billsAll })
      void qc.invalidateQueries({ queryKey: qk.usage })
    },
    onError: () => qc.invalidateQueries({ queryKey: qk.usage }),
  })
}

/** Short-lived signed URL for a receipt photo; refreshed before it expires (300 s). */
export const useFileUrl = (billId: UUID, fileId: UUID | undefined, enabled = true) =>
  useQuery({
    queryKey: ['receipt-file', billId, fileId ?? ''] as const,
    queryFn: () => fileUrl(billId, fileId as UUID),
    enabled: enabled && Boolean(fileId),
    staleTime: 240_000,
    gcTime: 270_000,
    retry: (count, err) => count < 1 && !(err instanceof Error && 'status' in err && (err as { status: number }).status < 500),
  })

export function useJob(jobId: UUID | null | undefined) {
  return useQuery({
    queryKey: qk.job(jobId ?? ''),
    queryFn: () => api<JobOut>(`/jobs/${jobId}`),
    enabled: Boolean(jobId),
    refetchInterval: (q) => {
      const job = q.state.data
      if (job && !isJobActive(job.status)) return false
      const started = job?.created_at ? Date.parse(job.created_at) : Date.now()
      return Date.now() - started < 10_000 ? 1000 : 2000
    },
    refetchIntervalInBackground: false,
  })
}

function useJobAction(action: 'cancel' | 'retry') {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (jobId: UUID) => api<JobOut>(`/jobs/${jobId}/${action}`, { method: 'POST' }),
    onSuccess: (job) => {
      qc.setQueryData(qk.job(job.id), job)
      void qc.invalidateQueries({ queryKey: qk.bill(job.bill_id) })
      void qc.invalidateQueries({ queryKey: qk.usage })
    },
  })
}
export const useCancelJob = () => useJobAction('cancel')
export const useRetryJob = () => useJobAction('retry')

export const fileUrl = (billId: UUID, fileId: UUID) =>
  api<{ url: string; expires_in: number; mime: string }>(`/bills/${billId}/files/${fileId}`)

// ---- share links ---------------------------------------------------------------------------------
/**
 * The one link per person and for the group chat, created when missing. Asking again returns the
 * same links (the server derives them), so this is a cached query rather than a mutation.
 */
export const useBillLinks = (billId: UUID, personIds: Array<UUID | null>, enabled = true) =>
  useQuery({
    queryKey: ['bill', billId, 'links', personIds] as const,
    enabled,
    staleTime: Infinity,
    queryFn: async () =>
      (await api<{ items: EnsuredLink[] }>(`/bills/${billId}/share-links/ensure`, {
        method: 'POST',
        body: { scopes: personIds.map((person_id) => ({ person_id })) },
      })).items,
  })

export const useResetLink = (billId: UUID) =>
  useMutation({ mutationFn: (linkId: UUID) => api<EnsuredLink>(`/bills/${billId}/share-links/${linkId}/reset`, { method: 'POST' }) })

/** Owner answers to "I've paid": every one returns the bill, and the inbox and badge follow. */
function useClaimMutation<V>(billId: UUID, fn: (v: V) => Promise<BillOut>) {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['bill', billId],
    mutationFn: fn,
    onSuccess: (bill) => {
      applyBill(qc, bill)
      void qc.invalidateQueries({ queryKey: qk.inbox })
      void qc.invalidateQueries({ queryKey: qk.mailbox })
      void qc.invalidateQueries({ queryKey: qk.me })
    },
  })
}
export const useConfirmClaim = (billId: UUID) =>
  useClaimMutation(billId, ({ claimId, amount_cents }: { claimId: UUID; amount_cents?: number }) =>
    api<BillOut>(`/bills/${billId}/claims/${claimId}/confirm`, { method: 'POST', body: amount_cents ? { amount_cents } : {} }),
  )
export const useRejectClaim = (billId: UUID) =>
  useClaimMutation(billId, (claimId: UUID) => api<BillOut>(`/bills/${billId}/claims/${claimId}/reject`, { method: 'POST' }))
export const useConfirmAll = (billId: UUID) =>
  useClaimMutation(billId, () => api<BillOut>(`/bills/${billId}/claims/confirm-all`, { method: 'POST' }))

/** Claims waiting across bills (Home's "To confirm"); refreshed when the app regains focus. */
export const useInbox = (enabled = true) =>
  useQuery({
    queryKey: qk.inbox,
    queryFn: async () => (await api<{ items: InboxClaim[] }>('/me/claims')).items,
    enabled,
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  })

export const usePublicShare = (token: string) =>
  useQuery({
    queryKey: qk.publicShare(token),
    queryFn: () => api<PublicShareOut>(`/public/share/${encodeURIComponent(token)}`, { auth: 'optional', timeoutMs: 75_000 }),
    retry: (count, err) => count < 2 && !(err as { status?: number }).status?.toString().startsWith('4'),
  })

// ---- admin ---------------------------------------------------------------------------------------
export const useAdminUsers = () =>
  useQuery({ queryKey: qk.adminUsers, queryFn: () => api<Page<AdminUserOut>>('/admin/users?limit=100') })
export const useAdminUsage = (month?: string) =>
  useQuery({ queryKey: qk.adminUsage(month), queryFn: () => api<AdminUsageOut>(`/admin/usage${month ? `?month=${month}` : ''}`) })
export const useAdminSettings = () => useQuery({ queryKey: qk.adminSettings, queryFn: () => api<AdminSettingsOut>('/admin/settings') })

export function useCreateUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: {
      username: string
      display_name?: string
      email?: string
      login?: 'password' | 'google'
      role?: 'member' | 'admin'
      monthly_scan_quota?: number
    }) => api<{ user: AdminUserOut; temp_password: string | null }>('/admin/users', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.adminUsers }),
  })
}

export function useUpdateUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: { id: UUID; display_name?: string; role?: 'member' | 'admin'; monthly_scan_quota?: number; disabled?: boolean }) =>
      api<AdminUserOut>(`/admin/users/${id}`, { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.adminUsers }),
  })
}

export const useResetPassword = () =>
  useMutation({ mutationFn: (id: UUID) => api<{ temp_password: string }>(`/admin/users/${id}/reset-password`, { method: 'POST' }) })

export function useDeleteAdminUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => api<void>(`/admin/users/${id}`, { method: 'DELETE' }),
    onSettled: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.adminUsers }),
        qc.invalidateQueries({ queryKey: ['admin', 'usage'] }),
      ])
    },
  })
}

export function useUpdateSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (
      body: Partial<Pick<AdminSettingsOut, 'global_monthly_page_cap' | 'global_monthly_llm_budget_micros' | 'default_user_quota' | 'scans_enabled'>> & {
        /** false clears a provider-reported pause for this month */
        provider_paused?: boolean
      },
    ) =>
      api<AdminSettingsOut>('/admin/settings', { method: 'PATCH', body }),
    onSuccess: (s) => {
      qc.setQueryData(qk.adminSettings, s)
      void qc.invalidateQueries({ queryKey: ['admin', 'usage'] })
    },
  })
}


// ---- friends -------------------------------------------------------------------------------------
export const useFriends = (enabled = true) =>
  useQuery({ queryKey: qk.friends, queryFn: () => api<FriendsOut>('/friends'), enabled })

/** Everything a friendship change can move: friends, people (linked entries), the Mailbox and its badge. */
function useSocialRefresh() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: qk.friends })
    void qc.invalidateQueries({ queryKey: qk.people })
    void qc.invalidateQueries({ queryKey: qk.mailbox })
    void qc.invalidateQueries({ queryKey: qk.me })
  }
}

export function useAskFriend() {
  const refresh = useSocialRefresh()
  return useMutation({
    mutationFn: (body: { identifier: string } | { account_id: UUID }) =>
      api<{ status: 'sent' | 'accepted' }>('/friends/requests', { method: 'POST', body }),
    onSuccess: refresh,
  })
}

export function useFriendAction() {
  const refresh = useSocialRefresh()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ action, id }: { action: 'accept' | 'decline' | 'cancel' | 'unfriend' | 'block' | 'unblock'; id: UUID }) => {
      switch (action) {
        case 'accept':
        case 'decline':
          return api<void>(`/friends/requests/${id}/${action}`, { method: 'POST' })
        case 'cancel':
          return api<void>(`/friends/requests/${id}`, { method: 'DELETE' })
        case 'unfriend':
          return api<void>(`/friends/${id}`, { method: 'DELETE' })
        case 'block':
          return api<void>(`/friends/${id}/block`, { method: 'POST' })
        case 'unblock':
          return api<void>(`/friends/${id}/block`, { method: 'DELETE' })
      }
    },
    onSuccess: () => {
      refresh()
      void qc.invalidateQueries({ queryKey: qk.summary })
    },
  })
}

/** Tag a placeholder with a friend (or take the invite back). */
export function useLinkPerson() {
  const refresh = useSocialRefresh()
  return useMutation({
    mutationFn: ({ personId, accountId }: { personId: UUID; accountId: UUID | null }) =>
      accountId
        ? api<void>(`/people/${personId}/link`, { method: 'POST', body: { account_id: accountId } })
        : api<void>(`/people/${personId}/link`, { method: 'DELETE' }),
    onSuccess: refresh,
  })
}

// ---- mailbox -------------------------------------------------------------------------------------
export const useMailbox = (enabled = true) =>
  useQuery({ queryKey: qk.mailbox, queryFn: () => api<MailboxOut>('/mailbox'), enabled, refetchOnWindowFocus: true })

/** The badge: requests waiting on you + unread updates. Polled lightly so it moves without a reload. */
export const useMailboxCount = (enabled = true) =>
  useQuery({
    queryKey: [...qk.me, 'mailbox-count'] as const,
    queryFn: async () => (await api<MeOut>('/me')).mailbox_count ?? 0,
    enabled,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 20_000,
  })

export function useMarkRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids?: UUID[]) => api<void>('/mailbox/read', { method: 'POST', body: ids ? { ids } : {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.me })
    },
  })
}

export function useAnswerLink() {
  const refresh = useSocialRefresh()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, accept }: { id: UUID; accept: boolean }) =>
      api<void>(`/mailbox/links/${id}/${accept ? 'accept' : 'decline'}`, { method: 'POST' }),
    onSuccess: () => {
      refresh()
      void qc.invalidateQueries({ queryKey: qk.billsAll })
      void qc.invalidateQueries({ queryKey: qk.summary })
    },
  })
}

// ---- groups --------------------------------------------------------------------------------------
export const useGroups = () =>
  useQuery({ queryKey: qk.groups, queryFn: async () => (await api<{ items: GroupOut[] }>('/groups')).items })

export function useSaveGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: { id?: UUID; name: string; person_ids: UUID[] }) =>
      id ? api<GroupOut>(`/groups/${id}`, { method: 'PATCH', body }) : api<GroupOut>('/groups', { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.groups })
      void qc.invalidateQueries({ queryKey: qk.summary })
    },
  })
}

export function useDeleteGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => api<void>(`/groups/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.groups }),
  })
}

export const useSendPlan = () =>
  useMutation({
    mutationFn: ({ groupId, currency, combine }: { groupId: UUID; currency: string; combine: string | null }) =>
      api<{ sent_to: number }>(`/groups/${groupId}/send-plan`, { method: 'POST', body: { currency, combine } }),
  })

// ---- account requests ----------------------------------------------------------------------------
export const useMyAccessRequest = (enabled: boolean) =>
  useQuery({
    queryKey: ['access-request', 'mine'] as const,
    queryFn: () => api<AccessRequestOut>('/access-requests/mine'),
    enabled,
    retry: false,
  })

export function useAskForAccess() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (note: string) => api<AccessRequestOut>('/access-requests', { method: 'POST', body: note ? { note } : {} }),
    onSuccess: (r) => qc.setQueryData(['access-request', 'mine'], r),
  })
}

export const useAccessRequests = () =>
  useQuery({ queryKey: qk.accessRequests, queryFn: async () => (await api<{ items: AccessRequestOut[] }>('/admin/access-requests')).items })

export function useAnswerAccess() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, approve, username, display_name }: { id: UUID; approve: boolean; username?: string; display_name?: string }) =>
      approve
        ? api<AccessRequestOut>(`/admin/access-requests/${id}/approve`, { method: 'POST', body: { username, ...(display_name ? { display_name } : {}) } })
        : api<AccessRequestOut>(`/admin/access-requests/${id}/reject`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.accessRequests })
      void qc.invalidateQueries({ queryKey: qk.adminUsers })
    },
  })
}
