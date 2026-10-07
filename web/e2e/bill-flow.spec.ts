import { randomUUID } from 'node:crypto'
import { expect, test as base, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { BillOut, BillSummaryOut, MeOut, Page as ApiPage, PersonOut, SummaryOut } from '../src/lib/types'
import { expectNoHorizontalOverflow, foregroundJson } from './support'

const test = base.extend<{ temporaryBills: Set<string> }>({
  temporaryBills: [async ({ page, browser }, useFixture, info) => {
    const ids = new Set<string>()
    try {
      await useFixture(ids)
    } finally {
      if (ids.size > 0) {
        if (!page.isClosed()) await page.close({ runBeforeUnload: false })
        const context = await browser.newContext({ storageState: info.project.use.storageState })
        const failures: string[] = []
        try {
          const cleanup = await context.newPage()
          await cleanup.goto(new URL(info.project.use.baseURL as string).origin)
          for (const id of ids) {
            try {
              const result = await foregroundJson(cleanup, `/bills/${id}?permanent=true`, 'DELETE')
              if (result.status !== 204) failures.push(`DELETE temporary bill ${id}: HTTP ${result.status}`)
              else {
                const absent = await foregroundJson(cleanup, `/bills/${id}`)
                if (absent.status !== 404) failures.push(`Temporary bill ${id} remains: HTTP ${absent.status}`)
              }
            } catch {
              failures.push(`Cleanup could not reach temporary bill ${id}.`)
            }
          }
        } finally {
          await context.close()
        }
        expect(failures, 'Temporary bill cleanup').toEqual([])
      }
    }
  }, { timeout: 20_000 }],
})

test.use({ trace: 'off', actionTimeout: 10_000, navigationTimeout: 15_000 })

async function get<T>(page: Page, path: string): Promise<T> {
  const result = await foregroundJson<T>(page, path)
  expect(result.status, `GET ${path}`).toBe(200)
  return result.data
}

function responseFor(page: Page, path: string, method: string, status = 200) {
  return page.waitForResponse((response) => new URL(response.url()).pathname === `/api${path}`
    && response.request().method() === method && response.status() === status, { timeout: 10_000 })
}

async function savedAction(page: Page, path: string, method: string, action: () => Promise<unknown>) {
  const response = responseFor(page, path, method)
  await action()
  return (await (await response).json()) as BillOut
}

async function withBills(page: Page, info: TestInfo, ids: Set<string>, run: (fixture: {
  name: string
  friend: PersonOut
  me: MeOut
  create: (action: () => Promise<unknown>) => Promise<BillOut>
}) => Promise<void>) {
  const origin = new URL(info.project.use.baseURL as string).origin
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(origin).hostname), 'Only the existing local fake-auth API is allowed.')
  await page.goto('/')
  const localSession = await page.evaluate(() => Boolean(localStorage.getItem('even.dev-session')))
  test.skip(!localSession, 'Requires the existing local dev-auth session, not a production account.')
  const people = await get<{ items: PersonOut[] }>(page, '/people')
  const friend = people.items.find((person) => !person.is_self && !person.archived_at && /^maya\b/i.test(person.name))
    ?? people.items.find((person) => !person.is_self && !person.archived_at)
  test.skip(!friend, 'No existing non-self person is available; this spec never creates friends or seeds data.')
  const me = await get<MeOut>(page, '/me')
  const name = `AUDIT E2E ${info.project.name} ${randomUUID()}`
  const create = async (action: () => Promise<unknown>) => {
    const captured = responseFor(page, '/bills', 'POST', 201).then(async (response) => {
      const bill = await response.json() as BillOut
      if (bill.title !== name && bill.merchant !== name) throw new Error('Refusing to register a non-test bill for deletion.')
      ids.add(bill.id)
      return bill
    })
    const results = await Promise.allSettled([captured, action()])
    for (const result of results) if (result.status === 'rejected') throw result.reason
    return (results[0] as PromiseFulfilledResult<BillOut>).value
  }
  await run({ name, friend: friend!, me, create })
}

async function pickFriend(page: Page, friend: PersonOut) {
  await page.getByRole('textbox', { name: 'Add or find someone', exact: true }).fill(friend.name)
  const checkbox = page.getByRole('checkbox', { name: friend.name, exact: true })
  await checkbox.check()
  await expect(checkbox).toBeChecked()
  await page.getByRole('textbox', { name: 'Add or find someone', exact: true }).clear()
}

async function manual(page: Page, name: string, create: (action: () => Promise<unknown>) => Promise<BillOut>) {
  await page.goto('/bills/new?mode=manual')
  await page.getByRole('textbox', { name: 'Where was it?', exact: true }).fill(name)
  await page.getByRole('combobox', { name: 'Currency', exact: true }).selectOption('SGD')
  const bill = await create(() => page.getByRole('button', { name: /^Next: who/ }).click())
  await expect(page).toHaveURL(new RegExp(`/bills/${bill.id}/people$`))
  await expect(page.getByRole('heading', { name: /Who.s splitting\?/ })).toBeVisible()
  return bill.id
}

async function addFriend(page: Page, id: string, friend: PersonOut) {
  await savedAction(page, `/bills/${id}/participants`, 'PUT', () => pickFriend(page, friend))
}

async function toReview(page: Page, id: string) {
  await page.getByRole('button', { name: 'Add items', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/bills/${id}/review$`))
  await expect(page.getByRole('textbox', { name: 'Item 1 name', exact: true })).toBeVisible()
}

async function enterItem(page: Page, name = 'AUDIT dish', price = '12.00') {
  await page.getByRole('textbox', { name: 'Item 1 name', exact: true }).fill(name)
  await page.getByRole('textbox', { name: 'Item 1 price each', exact: true }).fill(price)
}

function personRow(page: Page, friend: PersonOut) {
  return page.getByRole('list', { name: 'People', exact: true }).getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: friend.name, exact: true }) })
}

function billRow(page: Page, info: TestInfo, id: string, label: 'Bills' | 'Recent bills'): Locator {
  const main = page.locator('main')
  const link = page.locator(`a[href="/bills/${id}"]`).filter({ visible: true })
  return info.project.name === 'mobile'
    ? main.getByRole('list', { name: label, exact: true }).getByRole('listitem').filter({ has: link })
    : main.getByRole('table', { name: label, exact: true }).getByRole('row').filter({ has: link })
}

async function home(page: Page) {
  await page.getByRole('link', { name: 'Home', exact: true }).filter({ visible: true }).click()
  await expect(page).toHaveURL(/\/$/)
}

async function billsFilter(page: Page, info: TestInfo, label: 'Open' | 'Even') {
  await page.getByRole('link', { name: 'Bills', exact: true }).filter({ visible: true }).click()
  if (info.project.name === 'mobile') await page.locator('main').getByRole('combobox', { name: 'Show', exact: true }).selectOption({ label })
  else await page.locator('main').getByRole('button', { name: label, exact: true }).click()
}

test('manual: People, Review, Assign, Summary and item edits preserve assignments', async ({ page, temporaryBills }, info) => {
  await withBills(page, info, temporaryBills, async ({ name, friend, me, create }) => {
    const id = await manual(page, name, create)
    await addFriend(page, id, friend)
    await toReview(page, id)
    await enterItem(page)
    await savedAction(page, `/bills/${id}`, 'PATCH', () => page.getByRole('button', { name: 'Looks right', exact: true }).click())
    await expect(page.getByRole('heading', { name: 'Who had what?', exact: true })).toBeVisible()
    await page.getByRole('group', { name: 'Assigning for', exact: true }).getByRole('button', { name: new RegExp(`^${friend.name}`) }).click()
    const assigned = await savedAction(page, `/bills/${id}/assignments`, 'PUT', () =>
      page.getByRole('list', { name: /^Items/ }).getByRole('button', { name: /^AUDIT dish/ }).click())
    expect(assigned.items[0].shares.map((share) => share.person_id)).toEqual([friend.id])
    const itemId = assigned.items[0].id
    await savedAction(page, `/bills/${id}`, 'PATCH', () => page.getByRole('button', { name: 'See totals', exact: true }).click())
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
    await expect(personRow(page, friend)).toContainText('12.00')
    expect((await get<BillOut>(page, `/bills/${id}`)).payer_person_id).toBe(me.self_person_id)
    await page.getByRole('link', { name: 'Edit items', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Item 1 name', exact: true })).toHaveValue('AUDIT dish')
    await enterItem(page, 'AUDIT dish edited', '24.00')
    await savedAction(page, `/bills/${id}`, 'PATCH', () => page.getByRole('button', { name: 'Looks right', exact: true }).click())
    const edited = await get<BillOut>(page, `/bills/${id}`)
    expect(edited.items[0]).toMatchObject({ id: itemId, name: 'AUDIT dish edited', total_price_cents: 2400, split_mode: 'single' })
    expect(edited.items[0].shares).toEqual(assigned.items[0].shares)
    expect(edited.participants.map((person) => person.person_id)).toEqual([me.self_person_id, friend.id])
    await savedAction(page, `/bills/${id}`, 'PATCH', () => page.getByRole('button', { name: 'See totals', exact: true }).click())
    await expect(personRow(page, friend)).toContainText('24.00')
    const final = await get<BillOut>(page, `/bills/${id}`)
    expect(final.status).toBe('complete')
    expect(final.split.outstanding_total_cents).toBe(2400)
    await expectNoHorizontalOverflow(page)
  })
})

test('quick weighted split: partial payment agrees across Home/Bills, settle and Undo refresh caches', async ({ page, temporaryBills }, info) => {
  await withBills(page, info, temporaryBills, async ({ name, friend, me, create }) => {
    const baseline = await get<SummaryOut>(page, '/me/summary')
    const baselineCount = baseline.people.find((person) => person.person_id === friend.id && person.currency === 'SGD')?.bill_count ?? 0
    await page.getByRole('link', { name: 'Split a total', exact: true }).click()
    await page.getByRole('combobox', { name: 'Currency', exact: true }).selectOption('SGD')
    await page.getByRole('textbox', { name: 'Total', exact: true }).fill('30.00')
    await page.getByRole('textbox', { name: 'What was it?', exact: true }).fill(name)
    await pickFriend(page, friend)
    await page.getByRole('radio', { name: 'By shares', exact: true }).click()
    await page.getByRole('button', { name: `More shares for ${friend.name}`, exact: true }).click()
    const created = await create(() => page.getByRole('button', { name: 'Split it', exact: true }).click())
    const id = created.id
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
    const weighted = await get<BillOut>(page, `/bills/${id}`)
    expect(weighted.items[0].split_mode).toBe('weighted')
    expect(weighted.items[0].shares.map((share) => [share.person_id, Number(share.weight)])).toEqual([[me.self_person_id, 1], [friend.id, 2]])
    expect(weighted.split.people.find((person) => person.person_id === friend.id)?.total_cents).toBe(2000)
    await personRow(page, friend).getByRole('button', { name: friend.name, exact: true }).click()
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: friend.name, exact: true }) })
    await expect(dialog.getByRole('heading', { name: friend.name, exact: true })).toBeVisible()
    await dialog.getByRole('textbox', { name: 'Paid (SGD)', exact: true }).fill('5.00')
    const partial = await savedAction(page, `/bills/${id}/participants/${friend.id}/settlement`, 'POST', () => dialog.getByRole('button', { name: 'Save', exact: true }).click())
    expect(partial.split.people.find((person) => person.person_id === friend.id)).toMatchObject({ settled_amount_cents: 500, outstanding_cents: 1500 })
    await expect(dialog.getByText(/15\.00.*left/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await home(page)
    await expect(billRow(page, info, id, 'Recent bills')).toContainText('1 owe')
    const summary = await get<SummaryOut>(page, '/me/summary')
    expect(summary.bills.find((bill) => bill.bill_id === id)).toMatchObject({ owed_to_me_cents: 1500, unsettled_people: 1 })
    expect(summary.people.find((person) => person.person_id === friend.id && person.currency === 'SGD')?.bill_count).toBe(baselineCount + 1)
    if (info.project.name === 'desktop') {
      await expect(page.getByRole('list', { name: 'Who owes you', exact: true }).getByRole('listitem')
        .filter({ has: page.getByText(friend.name, { exact: true }) })).toContainText(`${baselineCount + 1} ${baselineCount + 1 === 1 ? 'bill' : 'bills'}`)
    }
    await billsFilter(page, info, 'Open')
    await expect(billRow(page, info, id, 'Bills')).toContainText('1 owe')
    const open = await get<ApiPage<BillSummaryOut>>(page, '/bills?status=complete&settled=false&limit=100')
    expect(open.items.find((bill) => bill.id === id)?.unsettled_count).toBe(1)
    await billRow(page, info, id, 'Bills').getByRole('link').click()
    await savedAction(page, `/bills/${id}/participants/${friend.id}/settlement`, 'POST', () => personRow(page, friend).getByRole('button', { name: 'Mark paid', exact: true }).click())
    await expect(page.getByRole('heading', { name: /Everyone.s even/ })).toBeVisible()
    await home(page)
    await expect(billRow(page, info, id, 'Recent bills')).toContainText('Even')
    expect((await get<SummaryOut>(page, '/me/summary')).bills.some((bill) => bill.bill_id === id)).toBe(false)
    await billsFilter(page, info, 'Even')
    await expect(billRow(page, info, id, 'Bills')).toContainText('Even')
    await billRow(page, info, id, 'Bills').getByRole('link').click()
    const undone = await savedAction(page, `/bills/${id}/participants/${friend.id}/settlement`, 'DELETE', () => personRow(page, friend).getByRole('button', { name: 'Undo', exact: true }).click())
    expect(undone.split.people.find((person) => person.person_id === friend.id)).toMatchObject({ settled_at: null, settled_amount_cents: null, outstanding_cents: 2000 })
    await home(page)
    await expect(billRow(page, info, id, 'Recent bills')).toContainText('1 owe')
    expect((await get<SummaryOut>(page, '/me/summary')).bills.find((bill) => bill.bill_id === id)?.owed_to_me_cents).toBe(2000)
    await billsFilter(page, info, 'Open')
    await expect(billRow(page, info, id, 'Bills')).toContainText('1 owe')
    await expectNoHorizontalOverflow(page)
  })
})

for (const editor of ['receipt', 'participants'] as const) {
  test(`Save & exit: ${editor} pending PUT fails twice, retains draft, Retry exit saves`, async ({ page, temporaryBills }, info) => {
    await withBills(page, info, temporaryBills, async ({ name, friend, me, create }) => {
      const id = await manual(page, name, create)
      if (editor === 'receipt') {
        await addFriend(page, id, friend)
        await toReview(page, id)
        await savedAction(page, `/bills/${id}/receipt`, 'PUT', () => enterItem(page))
      }
      const before = await get<BillOut>(page, `/bills/${id}`)
      const path = `/bills/${id}/${editor}`
      const editorPath = `/bills/${id}/${editor === 'receipt' ? 'review' : 'people'}`
      let fail = true
      let attempts = 0
      let release = () => {}
      const held = new Promise<void>((resolve) => { release = resolve })
      await page.route((url) => url.pathname === `/api${path}`, async (route) => {
        if (route.request().method() !== 'PUT' || !fail) return route.continue()
        attempts++
        if (attempts === 1) {
          await held
        }
        await route.fulfill({ status: 503, json: { code: 'audit_e2e_save_failed', detail: 'AUDIT E2E save failed. Retry.' } })
      })
      try {
        const failed = responseFor(page, path, 'PUT', 503)
        if (editor === 'receipt') await enterItem(page, 'AUDIT retained dish', '18.00')
        else await pickFriend(page, friend)
        await page.getByRole('button', { name: 'Save & exit', exact: true }).click()
        await expect.poll(() => attempts, { message: `Pending PUT ${path} reached its exact route` }).toBe(1)
        await expect(page).toHaveURL(new RegExp(`${editorPath}$`))
        await expect(page.getByRole('button', { name: 'Save & exit', exact: true })).toBeDisabled()
        expect(await get<BillOut>(page, `/bills/${id}`)).toEqual(before)
        release()
        await failed
        await expect(page.getByText('AUDIT E2E save failed. Retry.', { exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Retry exit', exact: true })).toBeEnabled()
        await expect(page).toHaveURL(new RegExp(`${editorPath}$`))
        const retained = async () => {
          if (editor === 'receipt') {
            await expect(page.getByRole('textbox', { name: 'Item 1 name', exact: true })).toHaveValue('AUDIT retained dish')
            await expect(page.getByRole('textbox', { name: 'Item 1 price each', exact: true })).toHaveValue('18.00')
          } else {
            await expect(page.getByRole('checkbox', { name: friend.name, exact: true })).toBeChecked()
            await expect(page.getByRole('checkbox', { name: /Me/ })).toBeChecked()
          }
        }
        await retained()
        const secondFailure = responseFor(page, path, 'PUT', 503)
        await page.getByRole('button', { name: 'Retry exit', exact: true }).click()
        await secondFailure
        await expect(page.getByRole('button', { name: 'Retry exit', exact: true })).toBeEnabled()
        await expect(page.getByText('AUDIT E2E save failed. Retry.', { exact: true })).toBeVisible()
        await expect(page).toHaveURL(new RegExp(`${editorPath}$`))
        await retained()
        expect(attempts).toBe(2)
        expect(await get<BillOut>(page, `/bills/${id}`)).toEqual(before)
        fail = false
        const saved = await savedAction(page, path, 'PUT', () => page.getByRole('button', { name: 'Retry exit', exact: true }).click())
        await expect(page).toHaveURL(/\/$/)
        expect(saved.participants.map((person) => person.person_id)).toEqual([me.self_person_id, friend.id])
        const persisted = await get<BillOut>(page, `/bills/${id}`)
        expect(persisted.participants).toEqual(saved.participants)
        if (editor === 'receipt') expect(persisted.items[0]).toMatchObject({ name: 'AUDIT retained dish', total_price_cents: 1800 })
        const resume = page.locator('main').locator(`a[href="/bills/${id}"]`).filter({ visible: true })
        await expect(resume).toContainText(name)
        await resume.click()
        await expect(page).toHaveURL(new RegExp(`${editorPath}$`))
        await retained()
        await expectNoHorizontalOverflow(page)
      } finally {
        release()
      }
    })
  })
}