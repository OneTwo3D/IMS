import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

/**
 * o3d-j625 r5 (review HIGH 6) — QUICKBOOKS RESOLVES AN ACCOUNT BY ITS ID BEFORE ITS ACCOUNT NUMBER.
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

test('[o3d-j625 r5 HIGH 6] a value that is one account\'s Id and ANOTHER account\'s number resolves to the Id', async () => {
  rows.length = 0
  rows.push(
    { connector: 'quickbooks', code: '35', externalAccountId: '7', active: true },   // AcctNum 35
    { connector: 'quickbooks', code: '1200', externalAccountId: '35', active: true }, // Id 35 — the confirmed one
  )
  const { resolveAccountRef } = await import('@/lib/connectors/quickbooks/api')

  assert.deepEqual(await resolveAccountRef('35'), { value: '35' },
    'the account whose Id is 35 — not the account numbered 35, which is a different bank account')
})

test('[o3d-j625 r5 HIGH 6] CONTROL: a value that is only an account NUMBER still resolves, to that account\'s Id', async () => {
  rows.length = 0
  rows.push({ connector: 'quickbooks', code: '1200', externalAccountId: '35', active: true })
  const { resolveAccountRef } = await import('@/lib/connectors/quickbooks/api')

  assert.deepEqual(await resolveAccountRef('1200'), { value: '35' })
  assert.equal(await resolveAccountRef('9999'), null, 'and a value in neither column resolves to nothing')
})

test('[o3d-j625 r5 HIGH 6] CONTROL: another connector\'s account is never resolved', async () => {
  rows.length = 0
  rows.push({ connector: 'xero', code: '35', externalAccountId: '35', active: true })
  const { resolveAccountRef } = await import('@/lib/connectors/quickbooks/api')

  assert.equal(await resolveAccountRef('35'), null)
})
