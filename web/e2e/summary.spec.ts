// The bill summary on a mocked API (share-link management left this page in Oct 2026; see .skills/DESIGN_SHARING.md).
import { expect, test, type Page } from '@playwright/test'
import type { BillOut, SplitPersonOut } from '../src/lib/types'
import { expectNoHorizontalOverflow } from './support'

test.use({ storageState: { cookies: [], origins: [] } })

const created = '2026-10-07T12:00:00Z'
const billId = 'share-test-bill'
const person = (id: string, name: string, payer = false, settled = false): SplitPersonOut => ({
  person_id: id, name, color_seed: 120, is_self: payer, is_payer: payer,
  items_cents: 1000, adjustment_cents: 0, total_cents: 1000, settle_total_cents: null,
  effective_total_cents: 1000, items: [], settled_at: settled ? created : null,
  settled_amount_cents: settled ? 1000 : null, outstanding_cents: payer || settled ? 0 : 1000,
})
const people = [person('self', 'You', true), person('maya', 'Maya'), person('tom', 'Tom', false, true)]
const bill: BillOut = {
  id: billId, title: 'Share test dinner', merchant: null, bill_date: '2026-10-07', currency: 'SGD',
  settle_currency: null, fx_rate: null, effective_currency: 'SGD', currency_locked: false,
  status: 'complete', source: 'manual', payer_person_id: 'self', subtotal_cents: 3000,
  grand_total_cents: 3000, tax_scenario: 'no_taxes', receipt_meta: {}, created_at: created, updated_at: created,
  items: [], charges: [], validation: null, latest_job: null, files: [],
  participants: people.map((row, position) => ({
    person_id: row.person_id, name: row.name, color_seed: row.color_seed, is_self: row.is_self,
    position, settled_at: row.settled_at, settled_amount_cents: row.settled_amount_cents,
  })),
  split: {
    currency: 'SGD', settle_currency: null, fx_rate: null, effective_currency: 'SGD', grand_total_cents: 3000,
    settle_grand_total_cents: null, all_items_cents: 3000, assigned_items_cents: 3000, payer_person_id: 'self',
    people, unassigned_item_ids: [], issues: [], is_complete: true, outstanding_total_cents: 1000,
  },
}
async function mockBill(page: Page) {
  const state = { unexpected: [] as string[] }
  await page.addInitScript(() => {
    localStorage.setItem('even.dev-session', JSON.stringify({ access_token: 'mock-only', expires_at: 4102444800 }))
  })
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const method = route.request().method()
    if (path === '/api/health') return route.fulfill({ json: { status: 'ok' } })
    if (path === '/api/me/usage') return route.fulfill({ json: {
      month: '2026-10', timezone: 'UTC', pages_used: 0, pages_quota: 30, pages_remaining: 30,
      llm_calls: 0, cost_micros: 0, scans_paused: false, pause_reason: null,
    } })
    if (path === '/api/me') return route.fulfill({ json: {
      id: 'test-owner', username: 'test-owner', display_name: 'Test owner', email: null, role: 'member',
      must_change_password: false, monthly_scan_quota: 30, default_currency: 'SGD', self_person_id: 'self', created_at: created,
    } })
    if (path === `/api/bills/${billId}` && method === 'GET') return route.fulfill({ json: bill })
    if (path === '/api/me/claims') return route.fulfill({ json: { items: [] } })
    state.unexpected.push(`${method} ${path}`)
    return route.abort('blockedbyclient')
  })
  return state
}

test('summary controls meet coarse touch sizes and ledger fits small and wide viewports', async ({ page }, info) => {
  const state = await mockBill(page)
  await page.goto(`/bills/${billId}`)
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
  expect(coarse).toBe(info.project.name === 'mobile')
  const widths = coarse ? [320, 390] : [1440]
  for (const width of widths) {
    await page.setViewportSize({ width, height: coarse ? 844 : 900 })
    const list = page.getByRole('list', { name: 'People', exact: true })
    // the toggle (you paid, so friends' money is Received), off and on, plus the people buttons
    const controls: Array<[string, boolean | undefined]> = [['You', undefined], ['Maya', undefined], ['Tom', undefined], ['Received', false], ['Received', true]]
    for (const [name, pressed] of controls) {
      const control = list.getByRole('button', { name, exact: true, pressed })
      await expect(control).toBeVisible()
      if (coarse) {
        const bounds = await control.boundingBox()
        expect(bounds?.height, `${name} height at ${width}px`).toBeGreaterThanOrEqual(44)
        expect(bounds?.width, `${name} width at ${width}px`).toBeGreaterThanOrEqual(44)
      }
    }
    await expectNoHorizontalOverflow(page)
    await page.screenshot({ path: `../.playwright-mcp/summary-${width}.png`, fullPage: true })
  }
  expect(state.unexpected).toEqual([])
})