import { expect, test, type Page } from '@playwright/test'
import type { BillOut, ShareLinkOut, SplitPersonOut } from '../src/lib/types'
import { expectNoHorizontalOverflow } from './support'

test.use({ storageState: { cookies: [], origins: [] } })

const created = '2026-10-07T12:00:00Z'
const billId = 'share-test-bill'
const linkPath = `/api/bills/${billId}/share-links`
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
const link = (id: string, overrides: Partial<ShareLinkOut> = {}): ShareLinkOut => ({
  id, person_id: 'maya', created_at: created, expires_at: null, revoked_at: null, last_viewed_at: null,
  ...overrides,
})

async function mockShares(page: Page, rows: ShareLinkOut[]) {
  const state = { rows, creates: 0, deletes: [] as string[], failRevoke: false, failList: false, unexpected: [] as string[] }
  await page.addInitScript(() => {
    localStorage.setItem('even.dev-session', JSON.stringify({ access_token: 'mock-only', expires_at: 4102444800 }))
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new DOMException('Denied', 'NotAllowedError') } },
    })
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
    if (path === linkPath && method === 'GET') {
      if (state.failList) return route.fulfill({ status: 503, json: { code: 'offline', detail: 'Links unavailable. Retry.' } })
      return route.fulfill({ json: { items: state.rows } })
    }
    if (path === linkPath && method === 'POST') {
      state.creates++
      const row = link(`new-${state.creates}`, { person_id: route.request().postDataJSON().person_id })
      state.rows = [...state.rows, row]
      const token = `share-test-token-${state.creates}`
      return route.fulfill({ json: { ...row, token, path: `/s/${token}`, url: `http://localhost:3000/s/${token}` } })
    }
    if (path.startsWith(linkPath) && method === 'DELETE') {
      if (state.failRevoke) {
        state.failRevoke = false
        return route.fulfill({ status: 503, json: { code: 'offline', detail: 'Revoke failed. Try again.' } })
      }
      const id = path.slice(linkPath.length + 1)
      state.deletes.push(id || 'all')
      state.rows = state.rows.map((row) => !id || row.id === id ? { ...row, revoked_at: created } : row)
      return route.fulfill({ status: 204 })
    }
    state.unexpected.push(`${method} ${path}`)
    return route.abort('blockedbyclient')
  })
  return state
}

test('share management confirms revocation, preserves failures for retry, and refreshes counts', async ({ page }) => {
  const state = await mockShares(page, [
    link('active'), link('expired', { person_id: null, expires_at: '2000-01-01T00:00:00Z' }),
    link('revoked', { person_id: 'tom', revoked_at: created }),
  ])
  await page.goto(`/bills/${billId}`)
  const section = page.getByRole('region', { name: 'Share links' })
  await expect(section.getByText('1 active', { exact: true })).toBeVisible()
  await section.locator('summary').click()
  await expect(section.getByText('2 of 50 link slots used')).toBeVisible()
  await expect(section.getByText('Expired links still use a slot until revoked.')).toBeVisible()
  await section.getByRole('button', { name: /^Revoke Maya link/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Revoke this link?' })).toBeVisible()
  expect(state.deletes).toEqual([])
  await dialog.getByRole('button', { name: 'Keep it' }).click()
  expect(state.deletes).toEqual([])
  state.failRevoke = true
  await section.getByRole('button', { name: /^Revoke Maya link/ }).click()
  await dialog.getByRole('button', { name: 'Revoke link', exact: true }).click()
  await expect(dialog.getByText('Revoke failed. Try again.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Revoke link', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('Link revoked', { exact: true })).toBeVisible()
  await expect(section.getByText('0 active', { exact: true })).toBeVisible()
  await expect(section.getByText('1 of 50 link slots used')).toBeVisible()
  await section.getByRole('button', { name: 'Revoke all', exact: true }).click()
  await expect(dialog.getByRole('heading', { name: 'Revoke all links?' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Revoke all', exact: true }).click()
  await expect(page.getByText('All links revoked', { exact: true })).toBeVisible()
  await expect(section.getByText('0 of 50 link slots used')).toBeVisible()
  await expect(section.getByRole('button', { name: 'Revoke all', exact: true })).toBeDisabled()
  expect(state.deletes).toEqual(['active', 'all'])
  expect(state.unexpected).toEqual([])
  await expectNoHorizontalOverflow(page)
})

test('expired cap has a revoke recovery path; manual fallback includes the local URL and reuses it', async ({ page }) => {
  const state = await mockShares(page, Array.from({ length: 50 }, (_, index) => link(`expired-${index}`, { expires_at: '2000-01-01T00:00:00Z' })))
  await page.goto(`/bills/${billId}`)
  const section = page.getByRole('region', { name: 'Share links' })
  const maya = page.getByRole('list', { name: 'People', exact: true }).locator('li').filter({ has: page.getByRole('button', { name: 'Maya', exact: true }) })
  await maya.getByRole('button', { name: 'Send link', exact: true }).click()
  await expect(page.getByText('50-link limit reached. Revoke links below before sending more.', { exact: true })).toBeVisible()
  expect(state.creates).toBe(0)
  await section.locator('summary').click()
  await expect(section.getByText('50 of 50 link slots used')).toBeVisible()
  await section.getByRole('button', { name: 'Revoke all', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke all', exact: true }).click()
  await expect(section.getByText('0 of 50 link slots used')).toBeVisible()
  await maya.getByRole('button', { name: 'Send link', exact: true }).click()
  const manual = page.getByRole('dialog')
  const origin = new URL(page.url()).origin
  await expect(manual.getByRole('textbox', { name: 'Share message and link' })).toHaveValue(`Share test dinner: your share\n${origin}/s/share-test-token-1`)
  await manual.getByRole('button', { name: 'Close', exact: true }).click()
  await maya.getByRole('button', { name: 'Send link', exact: true }).click()
  await expect(manual.getByRole('textbox')).toHaveValue(`Share test dinner: your share\n${origin}/s/share-test-token-1`)
  expect(state.creates).toBe(1)
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
  expect(stored).not.toContain('share-test-token')
  expect(state.unexpected).toEqual([])
})

test('link list errors provide a working retry', async ({ page }) => {
  const state = await mockShares(page, [])
  state.failList = true
  await page.goto(`/bills/${billId}`)
  const section = page.getByRole('region', { name: 'Share links' })
  await section.locator('summary').click()
  await expect(section.getByText('Links unavailable. Retry.')).toBeVisible()
  state.failList = false
  await section.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(section.getByText('No links yet')).toBeVisible()
  await expect(section.getByText('0 active', { exact: true })).toBeVisible()
  expect(state.unexpected).toEqual([])
})

test('summary controls meet coarse touch sizes and ledger fits small and wide viewports', async ({ page }, info) => {
  const state = await mockShares(page, [link('active')])
  await page.goto(`/bills/${billId}`)
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
  expect(coarse).toBe(info.project.name === 'mobile')
  const widths = coarse ? [320, 390] : [1440]
  for (const width of widths) {
    await page.setViewportSize({ width, height: coarse ? 844 : 900 })
    const list = page.getByRole('list', { name: 'People', exact: true })
    for (const name of ['You', 'Maya', 'Tom', 'Send link', 'Mark paid', 'Undo']) {
      const control = list.getByRole('button', { name, exact: true })
      await expect(control).toBeVisible()
      if (coarse) {
        const bounds = await control.boundingBox()
        expect(bounds?.height, `${name} height at ${width}px`).toBeGreaterThanOrEqual(44)
        expect(bounds?.width, `${name} width at ${width}px`).toBeGreaterThanOrEqual(44)
      }
    }
    await expectNoHorizontalOverflow(page)
    await page.screenshot({ path: `../.playwright-mcp/share-summary-${width}.png`, fullPage: true })
  }
  expect(state.unexpected).toEqual([])
})