// Sharing v2 end to end: the owner shares a quick split, a friend opens the group link signed out,
// picks their name and taps "I've paid", the owner confirms from the bill, the friend sees Even.
// Someone with an even account (Maya) has to sign in first: a link can be forwarded.
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { expectNoHorizontalOverflow, foregroundJson } from './support'

test('share → friend says paid → owner confirms → friend is even', async ({ page, browser, baseURL }) => {
  const title = `E2E share ${randomUUID().slice(0, 8)}`
  await page.goto('/bills/new?mode=quick')
  await page.getByRole('textbox', { name: 'Total', exact: true }).fill('60')
  await page.getByRole('textbox', { name: 'What was it?', exact: true }).fill(title)
  for (const [find, name] of [['Tom', 'Tomás Silva'], ['Maya', 'Maya Lim']] as const) {
    await page.getByRole('textbox', { name: 'Add or find someone', exact: true }).fill(find)
    await page.getByRole('checkbox', { name, exact: true }).check()
  }
  await page.getByRole('button', { name: 'Split it', exact: true }).click()
  await expect(page).toHaveURL(/\/bills\/[0-9a-f-]{36}$/)
  const billId = page.url().split('/bills/')[1] as string

  try {
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    const message = page.getByLabel('Message')
    await expect(message).toContainText('/s/')
    const text = await message.innerText()
    expect(text).toContain(`Tomás Silva  SGD 20.00`)
    expect(text.replace(/https?:\/\/\S+/, '')).not.toMatch(/[*_~]/) // no chat markup (tokens may hold _)
    const link = (text.match(/https?:\/\/\S+/) ?? [''])[0].replace(/^https?:\/\/[^/]+/, '')
    expect(link).toMatch(/^\/s\/[\w-]{22}#g$/)
    await page.getByRole('button', { name: 'Close', exact: true }).click()

    // a friend, signed out, on the group link
    const friendCtx = await browser.newContext({ storageState: { cookies: [], origins: [] }, baseURL })
    const friend = await friendCtx.newPage()
    await friend.goto(link)
    await expect(friend.getByRole('heading', { name: 'Which one is you?' })).toBeVisible()
    await expectNoHorizontalOverflow(friend)
    await friend.getByRole('button', { name: /Tomás Silva/ }).click()
    await friend.getByRole('button', { name: /I’ve paid/ }).click()
    await expect(friend.getByText(/Waiting for George to confirm/)).toBeVisible()

    // Maya is on even: her "I've paid" starts with signing in as her
    const mayaCtx = await browser.newContext({ storageState: { cookies: [], origins: [] }, baseURL })
    const maya = await mayaCtx.newPage()
    await maya.goto(link)
    await maya.getByRole('button', { name: /Maya Lim/ }).click()
    await expect(maya.getByRole('link', { name: 'Sign in to say you’ve paid' })).toHaveAttribute('href', /\/login\?next=/)
    await mayaCtx.close()

    // the owner sees the claim and confirms it
    await page.reload()
    const row = page.getByRole('list', { name: 'People', exact: true }).getByRole('listitem').filter({ hasText: 'Tomás' })
    await expect(row.getByText(/Says paid/)).toBeVisible()
    await row.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(row.getByRole('button', { name: 'Received', exact: true, pressed: true })).toBeVisible() // confirmed: the toggle is on

    await friend.reload()
    await expect(friend.getByText(/You’re even with George/)).toBeVisible()
    await friendCtx.close()
  } finally {
    await foregroundJson(page, `/bills/${billId}`, 'DELETE')
  }
})
