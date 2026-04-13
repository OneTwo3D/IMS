import { expect, test } from '@playwright/test'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './test-data'

const authFile = 'e2e/.auth/admin.json'

test('authenticate seeded admin user', async ({ page }) => {
  mkdirSync(dirname(authFile), { recursive: true })

  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'One Two Inventory' })).toBeVisible()

  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL)
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD)
  await page.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click()

  await page.waitForURL('**/dashboard')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

  await page.context().storageState({ path: authFile })
})
