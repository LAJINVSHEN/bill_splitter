import { test as setup } from '@playwright/test'
import { signIn } from './support'

// Signs in through the real login screen once and reuses the session for every spec.
setup('sign in as george', async ({ page }) => {
  await signIn(page, 'george')
  await page.context().storageState({ path: 'e2e/.auth/george.json' })
})
