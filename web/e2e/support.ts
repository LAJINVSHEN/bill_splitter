import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, type Page } from '@playwright/test'

/** DEV_LOGIN_PASSWORD from the environment (CI) or the repo-root .env (local). Never logged. */
export function devPassword(): string {
  if (process.env.DEV_LOGIN_PASSWORD) return process.env.DEV_LOGIN_PASSWORD
  const envPath = fileURLToPath(new URL('../../.env', import.meta.url))
  const line = readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .find((l) => /^\s*DEV_LOGIN_PASSWORD\s*=/.test(l))
  const value = line?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '')
  if (!value) throw new Error('DEV_LOGIN_PASSWORD is not set (env or root .env)')
  return value
}

export async function signIn(page: Page, username: string) {
  await page.goto('/login')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password', { exact: true }).fill(devPassword())
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/login/)
}

/** Layout is verified by measurement, not by eye (playbook §1.8). */
export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow, 'page scrolls sideways').toBeLessThanOrEqual(0)
}

export async function foregroundJson<T>(page: Page, path: string, method: 'GET' | 'DELETE' = 'GET') {
  return page.evaluate(async ({ path, method }) => {
    const modulePath = '/src/lib/env.ts'
    const { env } = await import(modulePath)
    const root = new URL(`${env.apiUrl}/api/`, location.origin)
    if (env.authMode !== 'dev' || !['localhost', '127.0.0.1'].includes(root.hostname)) {
      throw new Error('Foreground E2E requests require the local dev API.')
    }
    const raw = localStorage.getItem('even.dev-session')
    const session = raw ? JSON.parse(raw) : null
    if (!session?.access_token) throw new Error('Local dev session is missing.')
    const response = await fetch(new URL(path.replace(/^\//, ''), root), {
      method,
      headers: { Accept: 'application/json', Authorization: `Bearer ${session.access_token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    const data = response.status === 204 ? null : await response.json()
    return { status: response.status, data }
  }, { path, method }) as Promise<{ status: number; data: T }>
}
