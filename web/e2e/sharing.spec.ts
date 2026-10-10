// Sharing v2 end to end: the owner shares a quick split, a friend opens the group link signed out,
// picks their name and taps "I've paid", the owner confirms from the bill, the friend sees Even.
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { expectNoHorizontalOverflow, foregroundJson } from './support'

test('share → friend says paid → owner confirms → friend is even', async ({ page, browser, baseURL }) => {
  const title = `E2E share ${randomUUID().slice(0, 8)}`
  await page.goto('/bills/new?mode=quick')
  await page.getByRole('textbox', { name: 'Total', exact: true }).fill('60')
  await page.getByRole('textbox', { name: 'What was it?', exact: true }).fill(title)
  await page.getByRole('textbox', { name: 'Add or find someone', exact: true }).fill('Maya')
  await page.getByRole('checkbox', { name: 'Maya Lim', exact: true }).check()
  await page.getByRole('button', { name: 'Split it', exact: true }).click()
  await expect(page).toHaveURL(/\/bills\/[0-9a-f-]{36}$/)
  const billId = page.url().split('/bills/')[1] as string

  try {
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    const message = page.getByLabel('Message')
    await expect(message).toContainText('/s/')
    const text = await message.innerText()
    expect(text).toContain(`Maya Lim  SGD 30.00`)
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
    await friend.getByRole('button', { name: /Maya Lim/ }).click()
    await friend.getByRole('button', { name: /I’ve paid/ }).click()
    await expect(friend.getByText(/Waiting for George to confirm/)).toBeVisible()

    // the owner sees the claim and confirms it
    await page.reload()
    const row = page.getByRole('list', { name: 'People', exact: true }).getByRole('listitem').filter({ hasText: 'Maya' })
    await expect(row.getByText(/Says paid/)).toBeVisible()
    await row.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(row.getByText('Even', { exact: true })).toBeVisible()

    await friend.reload()
    await expect(friend.getByText(/You’re even with George/)).toBeVisible()
    await friendCtx.close()
  } finally {
    await foregroundJson(page, `/bills/${billId}`, 'DELETE')
  }
})
