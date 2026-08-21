import assert from 'node:assert/strict'
import test from 'node:test'

import {
  accountingEgressRefusal,
  currentAccountingEgressAuthorizations,
  withAccountingEgressAuthorization,
} from '@/lib/connectors/accounting-egress-authorization'

// ---------------------------------------------------------------------------
// o3d-k26m.5 round 6 — the ambient seam itself, with no connector anywhere near it.
//
// The properties here are the ones the invoice-number fence's soundness rests on: an authorisation in
// scope is ASKED, an authorisation out of scope is NOT, a nested scope does not repeal an outer one,
// and a scope belonging to another connector says nothing about this one. Xero is LIVE and is not
// touched by any of this.
// ---------------------------------------------------------------------------

/**
 * The request every authorisation is asked ABOUT (round 7): the organisation the call on the point of
 * leaving is addressed to, as the outgoing header spells it.
 */
const REQUEST = { tenantId: 'tenant-A' }

const allow = (name: string, calls: string[]) => ({
  connector: 'xero',
  name,
  authorize: async () => { calls.push(name); return null },
})

const refuse = (name: string, reason: string, calls: string[]) => ({
  connector: 'xero',
  name,
  authorize: async () => { calls.push(name); return reason },
})

test('outside any scope there is no question to answer, so nothing is refused', async () => {
  assert.equal(await accountingEgressRefusal('xero', REQUEST), null)
  assert.deepEqual(currentAccountingEgressAuthorizations('xero'), [])
})

test('an authorisation in scope is asked, and its refusal is what comes back', async () => {
  const calls: string[] = []
  const refusal = await withAccountingEgressAuthorization(
    refuse('slot', 'Refusing to post order 164981: sync row entry-rival is already in flight', calls),
    async () => accountingEgressRefusal('xero', REQUEST),
  )
  assert.equal(refusal, 'Refusing to post order 164981: sync row entry-rival is already in flight')
  assert.deepEqual(calls, ['slot'])
})

test('the scope does not leak past the call it wraps', async () => {
  const calls: string[] = []
  await withAccountingEgressAuthorization(refuse('slot', 'no', calls), async () => {})
  assert.equal(await accountingEgressRefusal('xero', REQUEST), null, 'a later request must not inherit a finished scope')
  assert.deepEqual(calls, [], 'and the authorisation must not have been asked at all')
})

test('nesting ACCUMULATES: an inner scope does not repeal an outer refusal', async () => {
  // The direction matters. These are preconditions on an irreversible write, so a narrower statement
  // ("the number is still ours") must not overrule a wider one ("this row is not ours any more").
  const calls: string[] = []
  const refusal = await withAccountingEgressAuthorization(
    refuse('outer-row-lease', 'the claim on this row was re-taken', calls),
    () => withAccountingEgressAuthorization(
      allow('inner-number-slot', calls),
      async () => accountingEgressRefusal('xero', REQUEST),
    ),
  )
  assert.equal(refusal, 'the claim on this row was re-taken')
  assert.deepEqual(calls, ['outer-row-lease'], 'the FIRST refusal short-circuits; the outermost reason is reported')
})

test('nesting asks BOTH when the outer one allows', async () => {
  const calls: string[] = []
  const refusal = await withAccountingEgressAuthorization(
    allow('outer-row-lease', calls),
    () => withAccountingEgressAuthorization(
      refuse('inner-number-slot', 'the number is in flight elsewhere', calls),
      async () => accountingEgressRefusal('xero', REQUEST),
    ),
  )
  assert.equal(refusal, 'the number is in flight elsewhere')
  assert.deepEqual(calls, ['outer-row-lease', 'inner-number-slot'])
})

test('an authorisation belonging to another connector is not consulted', async () => {
  const calls: string[] = []
  const refusal = await withAccountingEgressAuthorization(
    { connector: 'quickbooks', name: 'other', authorize: async () => { calls.push('other'); return 'nope' } },
    async () => accountingEgressRefusal('xero', REQUEST),
  )
  assert.equal(refusal, null)
  assert.deepEqual(calls, [], 'a Xero request must not be refused by a permission about someone else’s ledger')
})

test('a throwing authorisation propagates rather than being read as a pass', async () => {
  // Fail-closed: the throw aborts the call inside performRequest, so nothing is sent. Swallowing it
  // into `null` would turn an unreadable permission into permission.
  await assert.rejects(
    () => withAccountingEgressAuthorization(
      { connector: 'xero', name: 'boom', authorize: async () => { throw new Error('database unreachable') } },
      async () => accountingEgressRefusal('xero', REQUEST),
    ),
    /database unreachable/,
  )
})

test('concurrent scopes do not see each other', async () => {
  // AsyncLocalStorage, not a module-level variable: two entries posting at once must each carry only
  // their own precondition, or one worker's refusal blocks the other's unrelated write.
  const [a, b] = await Promise.all([
    withAccountingEgressAuthorization(
      refuse('a', 'refusal-a', []),
      async () => { await new Promise((r) => setTimeout(r, 5)); return accountingEgressRefusal('xero', REQUEST) },
    ),
    withAccountingEgressAuthorization(
      allow('b', []),
      async () => { await new Promise((r) => setTimeout(r, 1)); return accountingEgressRefusal('xero', REQUEST) },
    ),
  ])
  assert.equal(a, 'refusal-a')
  assert.equal(b, null)
})

test('EVERY authorisation is told which ledger the request is addressed to', async () => {
  // Round 7, finding 2. An authorisation is a statement about an ACT, and half of this act is which
  // organisation receives it. Without the request the invoice-number fence could only compare its
  // answer against a tenant it read for itself — a second resolution, minutes earlier, of the very
  // thing that may have changed. The seam carries the auth the outgoing request was built from, so
  // both entries in an accumulating scope are asked about the SAME request.
  const seen: Array<{ name: string; tenantId: string }> = []
  const record = (name: string) => ({
    connector: 'xero',
    name,
    authorize: async (request: { tenantId: string }) => { seen.push({ name, tenantId: request.tenantId }); return null },
  })

  const refusal = await withAccountingEgressAuthorization(
    record('outer-row-lease'),
    () => withAccountingEgressAuthorization(
      record('inner-number-slot'),
      async () => accountingEgressRefusal('xero', { tenantId: 'tenant-B' }),
    ),
  )

  assert.equal(refusal, null)
  assert.deepEqual(seen, [
    { name: 'outer-row-lease', tenantId: 'tenant-B' },
    { name: 'inner-number-slot', tenantId: 'tenant-B' },
  ], 'the ledger being written to must reach every precondition, not just the one that asked for it')
})

test('an authorisation may refuse on the ledger alone, and the refusal is the one reported', async () => {
  // The shape the invoice-number fence uses: an answer obtained from tenant-A cannot license a write
  // to tenant-B, and this is the only point where the two can be compared without a second token
  // resolution in between.
  const answeredBy = 'tenant-A'
  const refusal = await withAccountingEgressAuthorization(
    {
      connector: 'xero',
      name: 'answer-binding',
      authorize: async (request) =>
        request.tenantId === answeredBy ? null : `the ledger asked was ${answeredBy}, this request goes to ${request.tenantId}`,
    },
    async () => accountingEgressRefusal('xero', { tenantId: 'tenant-B' }),
  )
  assert.equal(refusal, 'the ledger asked was tenant-A, this request goes to tenant-B')
})
