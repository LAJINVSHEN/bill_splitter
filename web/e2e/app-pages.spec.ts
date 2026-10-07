import { expect, test } from '@playwright/test'
import { expectNoHorizontalOverflow, signIn } from './support'

// Read-only checks against the dev seed (george + maya, arjun, lena, tomas; 3 bills). Nothing here mutates data.

test('home: balances, drafts and recent bills', async ({ page }) => {
  await page.goto('/')
  const main = page.locator('main')
  await expect(main.getByText('Owed to you')).toBeVisible()
  await expect(main.getByRole('list', { name: 'Who owes you' }).getByText('Lena Okafor')).toBeVisible()
  await expect(main.getByRole('link', { name: /Team lunch/ })).toBeVisible()
  await expect(main.getByRole('link', { name: /Scan a receipt/ })).toHaveAttribute('href', '/bills/new?mode=scan')
  await expect(main.getByText('Saturday hotpot').filter({ visible: true })).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

test('bills: filters split open, settled and drafts', async ({ page }, info) => {
  await page.goto('/bills')
  const main = page.locator('main')
  const choose = async (label: string) => {
    if (info.project.name === 'mobile') await main.getByRole('combobox', { name: 'Show' }).selectOption({ label })
    else await main.getByRole('button', { name: label, exact: true }).click()
  }
  await choose('Drafts')
  await expect(page).toHaveURL(/show=drafts/)
  await expect(main.getByText('Team lunch').filter({ visible: true })).toBeVisible()
  await expect(main.getByText('Saturday hotpot').filter({ visible: true })).toHaveCount(0)
  await choose('Open')
  await expect(main.getByText('Saturday hotpot').filter({ visible: true })).toBeVisible()
  await expect(main.getByText('Team lunch').filter({ visible: true })).toHaveCount(0)
  await expectNoHorizontalOverflow(page)
})

test('account: saved rate with its inverse, and rate validation', async ({ page }) => {
  await page.goto('/account')
  const main = page.locator('main')
  await expect(main.getByText('1 JPY = 0.0091 SGD')).toBeVisible()
  await expect(main.getByText('1 SGD = 109.89010989 JPY')).toBeVisible()
  await main.getByRole('button', { name: 'Add rate' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel(/^1 \w{3} in \w{3}$/).fill('0')
  await dialog.getByRole('button', { name: 'Save rate' }).click()
  await expect(dialog.getByText('The rate must be more than 0.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expectNoHorizontalOverflow(page)
})

test('admin: taken usernames and self-demotion are explained inline', async ({ page }, info) => {
  await page.goto('/admin')
  const main = page.locator('main')
  await expect(main.getByRole('heading', { name: 'Accounts' })).toBeVisible()
  if (info.project.name === 'mobile') await main.getByRole('button', { name: 'New account' }).click()
  const form = info.project.name === 'mobile' ? page.getByRole('dialog') : main.locator('section', { has: page.getByRole('heading', { name: 'New account' }) })
  await form.getByLabel('Username').fill('Maya')
  await expect(form.getByLabel('Username')).toHaveValue('maya')
  await form.getByRole('button', { name: 'Create account' }).click()
  await expect(form.getByText('That username is taken.')).toBeVisible()
  if (info.project.name === 'mobile') await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

  await main.getByRole('button', { name: 'Edit George' }).filter({ visible: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Role').selectOption('member')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog.getByText('You can’t remove your own admin role.')).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

test('share: unknown links say so and stay out of search', async ({ page }) => {
  await page.goto('/s/not-a-real-token')
  await expect(page.getByRole('heading', { name: 'This link has expired or was turned off' })).toBeVisible()
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/)
  await expectNoHorizontalOverflow(page)
})

test.describe('as a member', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('no admin navigation, and /admin sends you home', async ({ page }) => {
    await signIn(page, 'maya')
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0)
  })
})
