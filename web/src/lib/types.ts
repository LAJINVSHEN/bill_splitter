/**
 * API contract (.skills/HANDOVER_P1_BACKEND.md §6). snake_case on the wire.
 * Money: integer MINOR units of the named currency (`*_cents`). Decimals (quantity, weight, rate): strings.
 */
export type UUID = string
export type Minor = number
export type Dec = string

export type BillStatus = 'draft' | 'scanning' | 'review' | 'assigning' | 'complete'
export type BillSource = 'scan' | 'manual' | 'quick'
export type SplitMode = 'single' | 'equal' | 'weighted' | 'custom'
export type ChargeKind = 'tax' | 'service' | 'discount' | 'rounding' | 'other'
export type TaxScenario = 'tax_exclusive' | 'tax_inclusive' | 'no_taxes'
export type JobStatus = 'queued' | 'ocr' | 'llm' | 'validating' | 'succeeded' | 'needs_review' | 'failed' | 'cancelled'

export interface MeOut {
  id: UUID
  username: string
  display_name: string
  email: string | null
  role: 'admin' | 'member'
  must_change_password: boolean
  monthly_scan_quota: number
  default_currency: string
  /** "PayNow 9123 4567": shown on share links when this user paid. Optional until every API has it. */
  payment_note?: string | null
  self_person_id: UUID
  created_at: string
}

export interface UsageOut {
  month: string
  timezone: string
  pages_used: number
  pages_quota: number
  pages_remaining: number
  llm_calls: number
  cost_micros: number
  scans_paused: boolean
  pause_reason: null | 'scans_disabled' | 'user_quota' | 'global_page_cap' | 'llm_budget'
}

export interface CurrencyBalance {
  currency: string
  owed_to_me_cents: Minor
  i_owe_cents: Minor
}

export interface SummaryOut {
  home: CurrencyBalance
  currencies: CurrencyBalance[]
  people: Array<{
    person_id: UUID
    name: string
    currency: string
    they_owe_me_cents: Minor
    i_owe_them_cents: Minor
    bill_count: number
  }>
  bills: Array<{
    bill_id: UUID
    title: string | null
    bill_date: string | null
    currency: string
    owed_to_me_cents: Minor
    i_owe_cents: Minor
    unsettled_people: number
  }>
}

export interface FxRateOut {
  base: string
  quote: string
  rate: Dec
  derived: boolean
  updated_at: string
}

export interface PersonOut {
  id: UUID
  name: string
  color_seed: number
  is_self: boolean
  last_used_at: string | null
  archived_at: string | null
  created_at: string
}

export interface ShareOut {
  person_id: UUID
  weight: Dec | null
  amount_cents: Minor | null
}

export interface ItemOut {
  id: UUID
  position: number
  name: string
  quantity: Dec
  unit_price_cents: Minor
  total_price_cents: Minor
  split_mode: SplitMode | null
  shares: ShareOut[]
}

export interface ChargeOut {
  id: UUID
  position: number
  name: string
  kind: ChargeKind
  amount_cents: Minor
  percent: Dec | null
}

export interface ParticipantOut {
  person_id: UUID
  name: string
  color_seed: number
  is_self: boolean
  position: number
  settled_at: string | null
  settled_amount_cents: Minor | null
}

export type ValidationErrorCode =
  | 'no_items'
  | 'grand_total_missing'
  | 'items_subtotal_mismatch'
  | 'grand_total_mismatch'
  | 'items_grand_mismatch'
  | 'no_scenario_matches'

export interface ValidationOut {
  ok: boolean
  tax_scenario: TaxScenario | null
  items_total_cents: Minor
  charges_total_cents: Minor
  grand_total_cents: Minor
  provided_subtotal_cents: Minor | null
  final_subtotal_cents: Minor | null
  message: string | null
  errors: Array<{ code: ValidationErrorCode; message: string; technical: string }>
  warnings: Array<{
    code: 'item_math_mismatch'
    item_index: number
    item_id: UUID | null
    message: string
    expected_cents: Minor
    actual_cents: Minor
  }>
}

export interface SplitPersonOut {
  person_id: UUID
  name: string
  color_seed: number
  is_self: boolean
  is_payer: boolean
  items_cents: Minor
  adjustment_cents: Minor
  total_cents: Minor
  settle_total_cents: Minor | null
  effective_total_cents: Minor
  items: Array<{ item_id: UUID; name: string; share_cents: Minor }>
  settled_at: string | null
  settled_amount_cents: Minor | null
  outstanding_cents: Minor
}

export type SplitIssueCode =
  | 'unassigned_item'
  | 'custom_amounts_mismatch'
  | 'zero_weights'
  | 'zero_items_subtotal'
  | 'no_participants'
  | 'share_not_participant'
  | 'single_has_many_shares'

export interface SplitOut {
  currency: string
  settle_currency: string | null
  fx_rate: Dec | null
  effective_currency: string
  grand_total_cents: Minor
  settle_grand_total_cents: Minor | null
  all_items_cents: Minor
  assigned_items_cents: Minor
  payer_person_id: UUID | null
  people: SplitPersonOut[]
  unassigned_item_ids: UUID[]
  issues: Array<{
    code: SplitIssueCode
    message: string
    item_id?: UUID | null
    person_id?: UUID | null
    expected_cents?: Minor | null
    actual_cents?: Minor | null
  }>
  is_complete: boolean
  outstanding_total_cents: Minor
}

export interface FileOut {
  id: UUID
  job_id: UUID | null
  mime: string
  bytes: number
  pages: number | null
  position: number
  created_at: string
  expires_at: string
  available: boolean
}

export interface BillOut {
  id: UUID
  title: string | null
  merchant: string | null
  bill_date: string | null
  currency: string
  settle_currency: string | null
  fx_rate: Dec | null
  effective_currency: string
  currency_locked: boolean
  /** not sent by the API: read latest_job.detected_currency. Kept optional for compatibility. */
  detected_currency?: string | null
  status: BillStatus
  source: BillSource
  payer_person_id: UUID | null
  subtotal_cents: Minor | null
  grand_total_cents: Minor | null
  tax_scenario: TaxScenario | null
  receipt_meta: Partial<
    Record<'receipt_number' | 'time' | 'store_address' | 'store_phone' | 'payment_method' | 'transaction_id' | 'notes', string>
  >
  created_at: string
  updated_at: string
  items: ItemOut[]
  charges: ChargeOut[]
  participants: ParticipantOut[]
  validation: ValidationOut | null
  split: SplitOut
  latest_job: {
    id: UUID
    status: JobStatus
    error_code: string | null
    retryable: boolean
    /** receipt currency when it differs from the bill's: offer a one-tap switch */
    detected_currency?: string | null
  } | null
  files: FileOut[]
}

export interface BillSummaryOut {
  id: UUID
  title: string | null
  merchant: string | null
  bill_date: string | null
  currency: string
  status: BillStatus
  source: BillSource
  grand_total_cents: Minor | null
  settle_currency?: string | null
  participant_count: number
  unsettled_count: number
  participant_names?: string[]
  unassigned_item_count?: number
  price_issue_count?: number
  validation_issue_count?: number
  created_at: string
  updated_at: string
}

export interface Page<T> {
  items: T[]
  next_cursor: string | null
}

export interface JobOut {
  id: UUID
  bill_id: UUID
  status: JobStatus
  attempts: number
  error_code: string | null
  error_message: string | null
  retryable: boolean
  model_used: string | null
  pages_billed: number
  detected_currency: string | null
  validation: ValidationOut | null
  timings: { ocr_ms?: number; llm_ms?: number; total_ms?: number }
  heartbeat_at: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
  updated_at: string
}

export interface ShareLinkOut {
  id: UUID
  person_id: UUID | null
  created_at: string
  expires_at: string | null
  revoked_at: string | null
  last_viewed_at: string | null
}

export interface ShareLinkCreated extends ShareLinkOut {
  token: string
  path: string
  url: string
}

export interface PublicPerson {
  name: string
  is_payer: boolean
  items: Array<{ name: string; share_cents: Minor }>
  items_cents: Minor
  adjustment_cents: Minor
  total_cents: Minor
  settle_total_cents: Minor | null
  settled: boolean
  outstanding_cents: Minor
}

export interface PublicShareOut {
  title: string | null
  merchant: string | null
  bill_date: string | null
  currency: string
  settle_currency: string | null
  fx_rate: Dec | null
  effective_currency: string
  grand_total_cents: Minor
  settle_grand_total_cents: Minor | null
  payer_name: string | null
  /** the bill owner's note, only when the owner paid; optional until every API has it */
  payer_payment_note?: string | null
  scope: 'person' | 'bill'
  person: PublicPerson | null
  people: PublicPerson[]
}

export interface AdminUserOut {
  id: UUID
  username: string
  email: string | null
  display_name: string
  role: 'admin' | 'member'
  must_change_password: boolean
  monthly_scan_quota: number
  disabled_at: string | null
  created_at: string
  pages_used_this_month: number
}

export interface AdminUsageOut {
  month: string
  timezone: string
  totals: {
    ocr_pages: number
    ocr_calls: number
    llm_calls: number
    input_tokens: number
    output_tokens: number
    cost_micros: number
    failed_calls: number
  }
  global_monthly_page_cap: number
  global_monthly_llm_budget_micros: number
  /** user_id/username are null for usage not tied to an account (e.g. a deleted user) */
  by_user: Array<{ user_id: UUID | null; username: string | null; ocr_pages: number; llm_calls: number; cost_micros: number; quota: number | null }>
  by_model: Array<{
    model: string
    calls: number
    failed_calls: number
    input_tokens: number
    output_tokens: number
    cost_micros: number
    avg_latency_ms: number
  }>
}

export interface AdminSettingsOut {
  global_monthly_page_cap: number
  global_monthly_llm_budget_micros: number
  default_user_quota: number
  scans_enabled: boolean
  /** hard OCR provider limits (Azure F0); optional until every API has them */
  provider?: {
    azure_di_monthly_page_limit: number
    azure_di_calls_per_minute_limit: number
    azure_di_calls_per_minute: number
    /** min(global_monthly_page_cap, azure_di_monthly_page_limit) */
    effective_monthly_page_cap: number
    /** "YYYY-MM" when Azure reported its quota exhausted */
    provider_paused_month: string | null
  }
  llm: {
    primary_model: string
    primary_reasoning_effort: string
    fallback_model: string | null
    fallback_reasoning_effort: string | null
    timeout_seconds: number
    max_retries: number
    backend: string
  }
  ocr_backend: string
  ocr_max_pdf_pages: number
  scan_max_files: number
  scan_max_file_bytes: number
  receipt_retention_days: number
  app_timezone: string
  updated_at: string
}
