import { expect, test } from '@playwright/test'
import { uniqueSuffix } from './helpers'
import { E2E_ADMIN_EMAIL } from './test-data'

test.describe.configure({ mode: 'serial' })

test.describe('backup and notification workflows', () => {
  test('creates and deletes a database backup from settings', async ({ page }) => {
    await page.goto('/settings/backup')
    await expect(page.getByRole('heading', { name: 'Backup & Restore', exact: true })).toBeVisible()

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /create backup/i }).click(),
    ])

    const filename = download.suggestedFilename()
    expect(filename).toMatch(/^backup-.*\.sql$/)

    await expect(page.getByText(/backup created and downloaded/i)).toBeVisible()

    const backupRow = page.locator('div.flex.items-center.justify-between').filter({ hasText: filename }).first()
    await expect(backupRow).toBeVisible()

    await backupRow.locator('button[title="Delete backup"]').click()

    await expect
      .poll(async () => await backupRow.count())
      .toBe(0)
  })

  test('shows notifications and marks them read from the topbar', async ({ page }) => {
    const suffix = uniqueSuffix()
    const ownedTitle = `E2E owned notification ${suffix}`
    const broadcastTitle = `E2E broadcast notification ${suffix}`

    const seedResponse = await page.request.post('/api/e2e/notifications', {
      data: {
        clearForUserEmail: E2E_ADMIN_EMAIL,
        notifications: [
          {
            userEmail: E2E_ADMIN_EMAIL,
            type: 'warning',
            title: ownedTitle,
            message: 'Owned notification for topbar E2E coverage.',
            actionUrl: '/profile',
          },
          {
            type: 'info',
            title: broadcastTitle,
            message: 'Broadcast notification for topbar E2E coverage.',
            actionUrl: null,
          },
        ],
      },
    })
    expect(seedResponse.ok()).toBeTruthy()

    await page.goto('/dashboard')
    const badge = page.locator('button[aria-label="Notifications"] > span')
    await expect(badge).toHaveText(/\d+/)
    await page.getByRole('button', { name: 'Notifications' }).click()

    await expect(page.getByText(ownedTitle, { exact: true })).toBeVisible()
    await expect(page.getByText(broadcastTitle, { exact: true })).toBeVisible()

    await page.getByText(ownedTitle, { exact: true }).click()
    await page.getByRole('button', { name: /open related page/i }).click()
    await expect(page).toHaveURL(/\/profile$/)

    await page.getByRole('button', { name: 'Notifications' }).click()
    await page.getByRole('button', { name: /mark all as read/i }).click()
    await expect(page.getByRole('button', { name: /mark all as read/i })).toHaveCount(0)
    await expect(badge).toHaveCount(0)
  })
})
