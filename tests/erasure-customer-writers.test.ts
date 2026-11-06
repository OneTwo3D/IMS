import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

/**
 * CENSUS OF EVERY WRITER OF THE CUSTOMER TABLE, each with a verdict, so a new writer fails here until it is classified.
 *
 *   refuses       writes only WHERE gdprAnonymisedAt IS NULL (or never matches an anonymised row), so an erased customer
 *                 cannot be changed by a stale read
 *   new-row       creates a row; nothing existing is touched
 *   non-identity  writes no identifying column (an archive flag, a ledger contact id)
 *   erasure       the erasure itself
 *   reset         the factory reset, which empties the database
 */
const CENSUS: Record<string, { calls: number; verdict: string }> = {
  'app/actions/customers.ts': { calls: 4, verdict: 'refuses (updateCustomer, CSV update) / new-row (createCustomer, CSV create)' },
  'app/actions/reset.ts': { calls: 1, verdict: 'reset' },
  'lib/connectors/woocommerce/sync/field-mapping.ts': { calls: 1, verdict: 'new-row; an anonymised match is refused before any link or return' },
  'lib/connectors/xero/auth.ts': { calls: 1, verdict: 'non-identity (disconnect clears the ledger contact id)' },
  'lib/connectors/xero/contacts.ts': { calls: 1, verdict: 'non-identity (stores the ledger contact id)' },
  'lib/data-retention.ts': { calls: 1, verdict: 'non-identity (archive flag)' },
  'lib/domain/erasure/erase-personal-data.ts': { calls: 1, verdict: 'erasure' },
}

test('every writer of the customer table is in the census', () => {
  const out = execFileSync('git', ['grep', '-n', '-E', '\\.customer\\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\\(', '--', 'app', 'lib', ':!app/generated', ':!*.test.ts'], {
    encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname,
  }).trim().split('\n').filter(Boolean)
  const found: Record<string, number> = {}
  for (const line of out) { const file = line.split(':')[0]!; found[file] = (found[file] ?? 0) + 1 }
  assert.deepEqual(found, Object.fromEntries(Object.entries(CENSUS).map(([f, v]) => [f, v.calls])))
})

test('the edit writers in customers.ts are conditional updateMany calls, never an unconditional update', () => {
  const src = readFileSync(new URL('../app/actions/customers.ts', import.meta.url), 'utf8')
  assert.ok(!/\.customer\.update\(/.test(src), 'an unconditional update by id would let a stale read write onto an erased customer')
  const conditional = src.match(/customer\.updateMany\(\{\s*where: \{ id(?:: existing\.id)?, gdprAnonymisedAt: null \}/g) ?? []
  assert.equal(conditional.length, 2, 'both the single edit and the CSV update carry the condition')
})

// ---------------------------------------------------------------- behaviour, with a recording database double.
const calls: Array<{ op: string; where: Record<string, unknown> }> = []
const existsAnonymised = true
mock.module('@/lib/db', {
  namedExports: {
    db: {
      customer: {
        updateMany: async ({ where }: { where: Record<string, unknown> }) => { calls.push({ op: 'updateMany', where }); return { count: 0 } },
        findUnique: async () => ({ gdprAnonymisedAt: existsAnonymised ? new Date() : null }),
        findMany: async () => [{ id: 'c1', email: null, firstName: 'GDPR', lastName: 'Anonymised', company: null, billingAddress: null, shippingAddress: null, gdprAnonymisedAt: new Date() }],
        update: async () => { throw new Error('an unconditional update must not be used') },
      },
    },
  },
})
mock.module('@/lib/auth/server', { namedExports: { requirePermission: async () => ({ user: { id: 'u1' } }), requireInternalUser: async () => ({ user: { id: 'u1' } }) } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined } })

test('updateCustomer writes only where gdprAnonymisedAt is null, and refuses an anonymised customer', async () => {
  const { updateCustomer } = await import('@/app/actions/customers')
  const result = await updateCustomer('c1', { firstName: 'New', email: 'x@example.test' })
  assert.equal(result.success, false)
  assert.match(String(result.error), /anonymised/)
  assert.deepEqual(calls[0]!.where, { id: 'c1', gdprAnonymisedAt: null })
})

test('a CSV row naming an anonymised customer by id is refused and skipped, never written', async () => {
  const { importContactsCsv } = await import('@/app/actions/customers')
  calls.length = 0
  const form = new FormData()
  form.set('file', new File(['customerId,firstName,email\nc1,New,x@example.test\n'], 'c.csv', { type: 'text/csv' }))
  const result = await importContactsCsv(form) as { errors?: string[]; updated?: number; skipped?: number }
  assert.equal(calls.length, 0, 'no write was attempted')
  assert.ok((result.errors ?? []).some((e) => /anonymised/.test(e)), JSON.stringify(result))
  assert.equal(result.updated ?? 0, 0)
})
