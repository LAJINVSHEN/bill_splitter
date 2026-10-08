import { expect, test } from '@playwright/test'
import { devPassword, expectNoHorizontalOverflow } from './support'

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('private pages redirect to sign-in and come back after', async ({ page }) => {
    await page.goto('/people')
    await expect(page).toHaveURL(/\/login\?next=%2Fpeople/)
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
    await expectNoHorizontalOverflow(page)

    await page.getByLabel('Username').fill('maya')
    await page.getByLabel('Password', { exact: true }).fill(devPassword())
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/people$/)
  })

  test('wrong password says so without leaving the form', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Username').fill('george')
    await page.getByLabel('Password', { exact: true }).fill('definitely-wrong')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByText('That username and password don’t match.')).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
  })
})

test('shell: main navigation reaches every section without sideways scroll', async ({ page }, info) => {
  await page.goto('/')
  const nav = page.getByRole('navigation', { name: 'Main' }).filter({ visible: true })
  const sections = info.project.name === 'mobile' ? ['Bills', 'People', 'Me', 'Home'] : ['Bills', 'People', 'Account', 'Admin', 'Home']
  for (const name of sections) {
    await nav.getByRole('link', { name, exact: true }).click()
    await expect(nav.getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'page')
    await expectNoHorizontalOverflow(page)
  }
})

test('desktop sidebar is welded to the left edge and sticky', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop layout only')
  await page.goto('/')
  const box = await page.locator('aside').first().boundingBox()
  expect(box?.x).toBe(0)
  const position = await page.locator('aside').first().evaluate((el) => getComputedStyle(el).position)
  expect(position).toBe('sticky')
})
