import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

/**
 * o3d-j625 r5 (review HIGH 6) / r6 (review H5) — THE ORDER DEPENDS ON WHERE THE VALUE CAME FROM.
 *
 * r6: chart settings store the account NUMBER when there is one, so they resolve code-first
 * (`resolveAccountRef`); the payment-account map stores the Id, so it resolves Id-first
 * (`resolvePaymentAccountRef`). r5 made the shared function Id-first for every caller.
 *
 * Both are short numeric strings in QuickBooks. `resolveAccountRef` tried `AcctNum` (stored as `code`)
 * first, so a value IMS had CONFIRMED as an account Id — "35" — re-resolved here to whichever account
 * happens to carry AcctNum 35, and the payment posted to a different bank account. Round 3 closed its
 * finding on the claim that the poster sends the confirmed id verbatim; this is what makes that true.
 *
 * The double evaluates the where clause over stored rows, so the assertion is about which row the
 * resolver's own predicates select — not about a call having been made.
 */
type Row = { connector: string; code: string | null; externalAccountId: string; active: boolean }
const rows: Row[] = []
const matches = (r: Row, where: Record<string, unknown>): boolean =>
  Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v)

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingAccount: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          const hit = rows.find((r) => matches(r, where))
          return hit ? { externalAccountId: hit.externalAccountId } : null
        },
      },
    },
  },
})

test('[o3d-j625 r6 H5] a CHART setting that is one account\'s NUMBER and another\'s Id resolves to the NUMBERED account', async () => {
  rows.length = 0
  rows.push(
    { connector: 'quickbooks', code: '200', externalAccountId: '7', active: true },   // AcctNum 200 — what the chart setting names
    { connector: 'quickbooks', code: '1200', externalAccountId: '200', active: true }, // Id 200 — a different account
  )
  const { resolveAccountRef } = await import('@/lib/connectors/quickbooks/api')

  assert.deepEqual(await resolveAccountRef('200'), { value: '7' },
    'the chart settings store AcctNum when an account has one; r5 resolved this to the account whose Id is 200')
})

test('[o3d-j625 r5 HIGH 6 / r6 H5] a PAYMENT-MAP value that is one account\'s Id and another\'s number resolves to the Id', async () => {
  rows.length = 0
  rows.push(
    { connector: 'quickbooks', code: '35', externalAccountId: '7', active: true },   // AcctNum 35
    { connector: 'quickbooks', code: '1200', externalAccountId: '35', active: true }, // Id 35 — the confirmed one
  )
  const { resolvePaymentAccountRef } = await import('@/lib/connectors/quickbooks/api')

  assert.deepEqual(await resolvePaymentAccountRef('35'), { value: '35' },
    'the account whose Id is 35 — not the account numbered 35, which is a different bank account')
})

test('[o3d-j625 r6 H5] CONTROL: each path still resolves the OTHER form when it is the only match', async () => {
  rows.length = 0
  rows.push({ connector: 'quickbooks', code: '1200', externalAccountId: '35', active: true })
  const { resolveAccountRef, resolvePaymentAccountRef } = await import('@/lib/connectors/quickbooks/api')

  assert.deepEqual(await resolveAccountRef('35'), { value: '35' }, 'a chart setting holding an Id (account with no number)')
  assert.deepEqual(await resolvePaymentAccountRef('1200'), { value: '35' }, 'a payment map holding a number')
  assert.equal(await resolveAccountRef('9999'), null)
  assert.equal(await resolvePaymentAccountRef('9999'), null)
})

test('[o3d-j625 r6 H5] the two QuickBooks payment posters use the payment resolver, and nothing else does', async () => {
  const { readFileSync } = await import('node:fs')
  const processor = readFileSync(`${process.cwd()}/lib/connectors/quickbooks/sync-processor.ts`, 'utf8')
  assert.equal((processor.match(/await resolvePaymentAccountRef\(bankAccountId\)/g) ?? []).length, 2,
    'INVOICE_PAYMENT and BILL_PAYMENT resolve their mapped bank account Id-first')
  assert.equal((processor.match(/resolveAccountRef\(bankAccountId\)/g) ?? []).length, 0)
})

test('[o3d-j625 r5 HIGH 6] CONTROL: another connector\'s account is never resolved', async () => {
  rows.length = 0
  rows.push({ connector: 'xero', code: '35', externalAccountId: '35', active: true })
  const { resolveAccountRef, resolvePaymentAccountRef } = await import('@/lib/connectors/quickbooks/api')

  assert.equal(await resolveAccountRef('35'), null)
  assert.equal(await resolvePaymentAccountRef('35'), null)
})
