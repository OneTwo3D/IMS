import { expect, test } from '@playwright/test'
import { generate } from 'otplib'
import { signIn } from './helpers'
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './test-data'

test.describe.configure({ mode: 'serial' })

async function freshCode(secret: string) {
  const seconds = Math.floor(Date.now() / 1000)
  const remaining = 30 - (seconds % 30)
  if (remaining < 5) {
    await new Promise((resolve) => setTimeout(resolve, (remaining + 1) * 1000))
  }
  return generate({ secret })
}

test.describe('security workflows', () => {
  test('enables TOTP, completes the 2FA challenge, and disables TOTP again', async ({ browser, page }) => {
    await page.goto('/profile')
    await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible()

    const setupResponse = await page.evaluate(async () => {
      const response = await fetch('/api/auth/totp-setup')
      return {
        ok: response.ok,
        status: response.status,
        body: await response.json(),
      }
    }) as { ok: boolean; status: number; body: { secret: string } }
    expect(setupResponse.ok).toBeTruthy()
    const { secret } = setupResponse.body

    const enableResponse = await page.evaluate(async (code) => {
      const response = await fetch('/api/auth/totp-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      return { ok: response.ok, status: response.status }
    }, await freshCode(secret)) as { ok: boolean; status: number }
    expect(enableResponse.ok).toBeTruthy()

    await page.reload()
    await expect(page.getByRole('button', { name: /disable 2fa/i })).toBeVisible()

    const challengePage = await browser.newPage({ storageState: { cookies: [], origins: [] } })
    await signIn(challengePage, E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD)
    await challengePage.waitForURL(/\/2fa$/)
    await expect(challengePage.getByRole('heading', { name: 'Two-factor authentication', exact: true })).toBeVisible()

    const challengeCode = await freshCode(secret)
    await challengePage.getByLabel('Authenticator code').fill(challengeCode)
    const verifyResponse = await challengePage.evaluate(async (code) => {
      const response = await fetch('/api/auth/totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      return {
        ok: response.ok,
        status: response.status,
        body: await response.json(),
      }
    }, challengeCode) as { ok: boolean; status: number; body: { success?: boolean; totpToken?: string } }
    expect(verifyResponse.ok).toBeTruthy()
    expect(verifyResponse.body.success).toBeTruthy()
    expect(verifyResponse.body.totpToken).toBeTruthy()
    await challengePage.close()

    const disableResponse = await page.evaluate(async (code) => {
      const response = await fetch('/api/auth/totp-setup', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      return { ok: response.ok, status: response.status }
    }, await freshCode(secret)) as { ok: boolean; status: number }
    expect(disableResponse.ok).toBeTruthy()

    await page.goto('/profile')
    await expect(page.getByRole('button', { name: /enable 2fa/i })).toBeVisible()
  })
})
