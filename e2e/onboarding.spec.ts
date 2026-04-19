import { execFileSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'
import { uniqueSuffix } from './helpers'

const databaseUrl = process.env.DATABASE_URL!

function psql(query: string) {
  return execFileSync('psql', [databaseUrl, '-At', '-F', '|', '-c', query], {
    encoding: 'utf8',
  }).trim()
}

function resetOnboardingState() {
  psql(`
    update organisations
    set
      name = 'onetwoInventory',
      "legalName" = null,
      "vatNumber" = null,
      "companyNumber" = null,
      "addressLine1" = null,
      "addressLine2" = null,
      city = null,
      county = null,
      postcode = null,
      country = 'GB',
      phone = null,
      email = null,
      website = null,
      "logoUrl" = null,
      "documentLogoUrl" = null
    where id = 'default';

    delete from settings
    where key in ('onboarding_complete', 'onboarding_dismissed', 'onboarding_current_step');

    insert into settings(key, value, "updatedAt")
    values
      ('onboarding_complete', 'false', now()),
      ('onboarding_dismissed', 'false', now()),
      ('onboarding_current_step', '1', now())
    on conflict (key) do update
    set value = excluded.value, "updatedAt" = now();
  `)
}

function inputForTextLabel(page: Page, label: string) {
  return page.locator(`label:has-text("${label}") + input`)
}

test.describe('onboarding workflow', () => {
  test.beforeEach(() => {
    resetOnboardingState()
  })

  test.afterEach(() => {
    resetOnboardingState()
  })

  test('admin can resume onboarding from the dashboard banner and complete the wizard', async ({ page }) => {
    const companyName = `E2E Onboarding ${uniqueSuffix()}`

    await page.goto('/dashboard')
    await expect(page.getByText('Complete the setup wizard to configure your company')).toBeVisible()
    await page.getByRole('link', { name: /complete setup/i }).click()

    await page.waitForURL('**/onboarding')
    await expect(page.getByRole('heading', { name: 'Company Details' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'All Done' })).toBeDisabled()

    await inputForTextLabel(page, 'Company Name').fill(companyName)
    await page.getByRole('button', { name: /save company details/i }).click()
    await expect(page.getByText('Base currency is locked after setup. Reset the database to change it.')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Next$/ })).toBeEnabled()

    await page.getByRole('button', { name: /^Next$/ }).click()
    await expect(page.getByRole('heading', { name: 'Currency & Financial Year' })).toBeVisible()
    await expect(page.getByText(/Base currency is locked to/i)).toBeVisible()

    await page.getByRole('button', { name: /^Next$/ }).click()
    await expect(page.getByRole('heading', { name: 'Tax Rates' })).toBeVisible()

    await page.getByRole('button', { name: 'Skip' }).click()
    await expect(page.getByRole('heading', { name: 'Integrations', exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Skip' }).click()
    await expect(page.getByRole('heading', { name: 'Warehouses' }).first()).toBeVisible()

    await page.getByRole('button', { name: 'Skip' }).click()
    await expect(page.getByRole('heading', { name: 'Import Products' })).toBeVisible()

    await page.getByRole('button', { name: 'Skip' }).click()
    await expect(page.getByRole('heading', { name: 'Opening Stock' })).toBeVisible()

    await page.getByRole('button', { name: 'Skip' }).click()
    await expect(page.getByRole('heading', { name: 'Setup Complete' })).toBeVisible()

    await page.getByRole('button', { name: /go to dashboard/i }).click()
    await page.waitForURL('**/dashboard')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(page.getByText('Complete the setup wizard to configure your company')).toHaveCount(0)

    expect(psql(`select value from settings where key = 'onboarding_complete' limit 1;`)).toBe('true')
    expect(psql(`select name from organisations where id = 'default' limit 1;`)).toBe(companyName)
  })
})
