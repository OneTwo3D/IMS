import { expect, test } from '@playwright/test'

test.use({ storageState: { cookies: [], origins: [] } })

test('redirects anonymous users from root to login', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/login\?callbackUrl=%2F/)
  await expect(page.getByRole('heading', { name: 'One Two Inventory' })).toBeVisible()
})
