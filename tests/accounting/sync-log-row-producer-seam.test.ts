import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { ledgerStanding, isShadowedObligation, workSlotStanding } from '@/lib/domain/accounting/ledger-standing'
import { classifyPriorAttempts } from '@/lib/domain/accounting/prior-posting-evidence'
import { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV } from '@/lib/security/producer-disposition-constants'
import { OUTBOUND_GRANT_ENV } from '@/lib/security/outbound-write-hold-constants'

/**
 * THE XERO PRODUCER SEAM AT THE ONE PRIMITIVE, AND THE DIFFERENTIAL: SAME INPUTS, SWITCH OFF vs ON.
 *
 * Driven through the real createAccountingSyncLogRow with a recording client. The database facts (the unique key, the
 * counting of repeats) are proved against a real Postgres in tests/db/xero-producer-seam.test.ts and
 * tests/concurrency/producer-shadow-race.concurrent.test.ts; here the double stands in for them and the SHAPE of what is
 * written is asserted.
 *
 * Named mutations (shown red in the PR, restored from a copy, md5-verified):
 *  a  shadow-queues-a-row   the shadow branch writes status PENDING: the "shadow is CANCELLED / HELD_SHADOW" arm goes red
 *  b  live-without-grant    the seam answers live when no grant is set: the ungranted arm goes red
 *  c  seam-bypassed         createAccountingSyncLogRow stops asking the seam: the shadow arms go red
 *  d  hold-before-suppress  the seam is asked before the hand-post suppression read: the suppression arm goes red
 */

// The activity log would otherwise reach for a real database from the suppression report and the refusal clear.
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined, logActivityPersisted: async () => true } })
async function createAccountingSyncLogRow(client: never, data: never) {
  const primitive = await import('@/lib/domain/accounting/sync-log-row')
  return primitive.createAccountingSyncLogRow(client, data)
}

const TENANT = '4f7f0c6e-1111-4222-8333-944455556666'
const ENV_KEYS = [PRODUCER_HOLD_ENFORCED_ENV, OUTBOUND_GRANT_ENV.xero, PRODUCER_CUTOFF_ENV.xero]

function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value
  return fn().finally(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

type Recorded = { creates: Array<Record<string, unknown>>; shadowUpserts: number }

function recordingClient(options: { suppressed?: boolean; shadowTable?: 'ok' | 'fails' | 'repeat' } = {}) {
  const recorded: Recorded = { creates: [], shadowUpserts: 0 }
  const client = {
    accountingSyncLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        recorded.creates.push(data)
        return { id: `row-${recorded.creates.length}`, ...data }
      },
    },
    accountingPostingRefusal: options.suppressed
      ? { findUnique: async () => ({ suppressedAt: new Date('2026-05-01T00:00:00Z'), resolvedBy: 'operator', handPostClaimedAt: null, handPostClaimedBy: null }) }
      : { findUnique: async () => null },
    $queryRaw: async (query: { strings?: readonly string[] }) => {
      const text = (query.strings ?? []).join('?')
      if (!text.includes('outbound_shadow_writes')) return []
      recorded.shadowUpserts += 1
      if (options.shadowTable === 'fails') throw new Error('relation "outbound_shadow_writes" does not exist')
      if (options.shadowTable === 'repeat') {
        return [{ id: 'shadow-1', inserted: false, occurrences: 2, accounting_sync_log_id: 'row-existing', sync_row_exists: true }]
      }
      return [{ id: 'shadow-1', inserted: true, occurrences: 1, accounting_sync_log_id: null, sync_row_exists: false }]
    },
    $executeRaw: async () => 1,
  }
  return { client, recorded }
}

const row = (over: Record<string, unknown> = {}) => ({
  connector: 'xero',
  type: 'PURCHASE_INVOICE',
  status: 'PENDING',
  referenceType: 'PurchaseOrder',
  referenceId: 'po-1',
  payload: { date: '2026-06-01', _idempotencyKey: 'k-1', amount: 12.5 },
  ...over,
})

test('DIFFERENTIAL, switch OFF: with no grants set the row is created exactly as before, PENDING, and no shadow is recorded', async () => {
  await withEnv({}, async () => {
    const { client, recorded } = recordingClient()
    const result = await createAccountingSyncLogRow(client as never, row() as never)
    console.log(`# switch off: result=${JSON.stringify(result)} creates=${recorded.creates.length} shadowUpserts=${recorded.shadowUpserts}`)
    assert.equal(recorded.creates.length, 1)
    assert.equal(recorded.creates[0]!.status, 'PENDING')
    assert.equal(recorded.creates[0]!.settlementBasis, undefined)
    assert.equal(recorded.creates[0]!.abandonedBeforeRemoteCall, undefined)
    assert.deepEqual(result, { row: { id: 'row-1', ...row() }, suppressed: null })
    assert.equal(recorded.shadowUpserts, 0)
  })
})

test('DIFFERENTIAL, switch ON and no grant (the P0/P1 posture): NO queued row is created; a CANCELLED / HELD_SHADOW row is, and it reads as a shadow (not proof of absence)', async () => {
  await withEnv({ [PRODUCER_HOLD_ENFORCED_ENV]: 'xero' }, async () => {
    const { client, recorded } = recordingClient()
    const result = await createAccountingSyncLogRow(client as never, row() as never)
    console.log(`# switch on, ungranted: creates=${JSON.stringify(recorded.creates.map((c) => [c.status, c.settlementBasis, c.abandonedBeforeRemoteCall]))} shadowUpserts=${recorded.shadowUpserts}`)
    assert.equal(recorded.shadowUpserts, 1, 'precondition: the shadow was recorded')
    assert.equal(recorded.creates.length, 1)
    const written = recorded.creates[0]!
    assert.equal(written.status, 'CANCELLED')
    assert.notEqual(written.status, 'PENDING')
    assert.equal(written.settlementBasis, 'HELD_SHADOW')
    assert.equal(written.abandonedBeforeRemoteCall, true)
    assert.equal(written.externalTransactionId, null)
    assert.match(String(written.errorMessage), /^Not sent by IMS: writes to Xero are held on this installation/)
    assert.match(String(written.errorMessage), /Owner of this operation in the current phase: Qoblex/)
    assert.equal(result.row, null)
    assert.ok(result.shadowed, 'the caller is told it is a shadow')
    assert.equal(result.suppressed, null)
    const standing = { status: String(written.status), externalTransactionId: null, abandonedBeforeRemoteCall: true, settlementBasis: String(written.settlementBasis) }
    assert.equal(ledgerStanding(standing), 'SHADOW_NOT_SENT_BY_IMS')
    assert.equal(isShadowedObligation(standing), true)
  })
})

test('switch ON + the full grant, an IMS-owned type, a date after the cut-off: the row is created LIVE, byte-for-byte what the switch-off run creates', async () => {
  const live = { [PRODUCER_HOLD_ENFORCED_ENV]: 'xero', [OUTBOUND_GRANT_ENV.xero]: TENANT, [PRODUCER_CUTOFF_ENV.xero]: '2026-01-01T00:00:00Z' }
  const off = recordingClient()
  await withEnv({}, () => createAccountingSyncLogRow(off.client as never, row() as never))
  const on = recordingClient()
  await withEnv(live, () => createAccountingSyncLogRow(on.client as never, row() as never))
  console.log(`# live write: off=${JSON.stringify(off.recorded.creates)} on=${JSON.stringify(on.recorded.creates)}`)
  assert.equal(on.recorded.creates.length, 1)
  assert.deepEqual(on.recorded.creates, off.recorded.creates, 'the live row is identical with the switch on and the switch off')
  assert.equal(on.recorded.shadowUpserts, 0)
})

test('switch ON + the full grant but the operation belongs to Xeroom (SALES_INVOICE): still a shadow, with the owner named', async () => {
  const live = { [PRODUCER_HOLD_ENFORCED_ENV]: 'xero', [OUTBOUND_GRANT_ENV.xero]: TENANT, [PRODUCER_CUTOFF_ENV.xero]: '2026-01-01T00:00:00Z' }
  await withEnv(live, async () => {
    const { client, recorded } = recordingClient()
    const result = await createAccountingSyncLogRow(client as never, row({ type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1' }) as never)
    assert.ok(result.shadowed)
    assert.equal(recorded.creates[0]!.status, 'CANCELLED')
    assert.match(String(recorded.creates[0]!.errorMessage), /Owner of this operation in the current phase: Xeroom/)
    assert.match(String(recorded.creates[0]!.errorMessage), /another writer owns this operation in the current phase/)
  })
})

test('a REPEAT of shadowed work writes no second row: the shadow store names the row that already carries it', async () => {
  await withEnv({ [PRODUCER_HOLD_ENFORCED_ENV]: 'xero' }, async () => {
    const { client, recorded } = recordingClient({ shadowTable: 'repeat' })
    const result = await createAccountingSyncLogRow(client as never, row() as never)
    assert.deepEqual(result, { row: null, suppressed: null, shadowed: { id: 'row-existing' } })
    assert.equal(recorded.creates.length, 0, 'no new sync-log row')
    assert.equal(recorded.shadowUpserts, 1, 'precondition: the repeat was counted')
  })
})

test('LOST EVIDENCE IS NEVER LOST WORK: a failed shadow record still leaves the CANCELLED shadow row, and nothing queued', async () => {
  await withEnv({ [PRODUCER_HOLD_ENFORCED_ENV]: 'xero' }, async () => {
    const { client, recorded } = recordingClient({ shadowTable: 'fails' })
    const originalError = console.error
    const logged: string[] = []
    console.error = (...args: unknown[]) => { logged.push(args.join(' ')) }
    try {
      const result = await createAccountingSyncLogRow(client as never, row() as never)
      assert.ok(result.shadowed)
    } finally { console.error = originalError }
    assert.equal(recorded.shadowUpserts, 1, 'precondition: the record was attempted and failed')
    assert.equal(recorded.creates.length, 1)
    assert.equal(recorded.creates[0]!.status, 'CANCELLED')
    assert.ok(logged.some((line) => /could not record the shadow/.test(line)), 'and it is reported')
  })
})

test('HAND-POST SUPPRESSION WINS OVER A SHADOW: a posting marked handled by hand is answered as such, no shadow is recorded and nothing is written', async () => {
  await withEnv({ [PRODUCER_HOLD_ENFORCED_ENV]: 'xero' }, async () => {
    const { client, recorded } = recordingClient({ suppressed: true })
    const result = await createAccountingSyncLogRow(client as never, row() as never)
    console.log(`# suppressed + enforced: ${JSON.stringify(result)} creates=${recorded.creates.length} shadowUpserts=${recorded.shadowUpserts}`)
    assert.deepEqual(result, { row: null, suppressed: 'handled_by_hand' })
    assert.equal(recorded.creates.length, 0)
    assert.equal(recorded.shadowUpserts, 0)
  })
})

test('a shadow does not clear an outstanding refusal (it is not a posting): no refusal table write happens on the shadow path', async () => {
  await withEnv({ [PRODUCER_HOLD_ENFORCED_ENV]: 'xero' }, async () => {
    const { client } = recordingClient()
    let refusalWrites = 0
    ;(client.accountingPostingRefusal as Record<string, unknown>).updateMany = async () => { refusalWrites += 1; return { count: 0 } }
    ;(client.accountingPostingRefusal as Record<string, unknown>).deleteMany = async () => { refusalWrites += 1; return { count: 0 } }
    ;(client.accountingPostingRefusal as Record<string, unknown>).update = async () => { refusalWrites += 1; return {} }
    await createAccountingSyncLogRow(client as never, row() as never)
    assert.equal(refusalWrites, 0)
  })
})

test('A SHADOW NEVER BLOCKS THE LIVE POSTING THAT FOLLOWS IT: the prior-attempt verdict over a shadow row is "none", so a later LIVE enqueue for the same key is queued, not suppressed as already-queued', () => {
  const shadow = { id: 'row-shadow', status: 'CANCELLED', externalTransactionId: null, abandonedBeforeRemoteCall: true, settlementBasis: 'HELD_SHADOW' }
  assert.equal(workSlotStanding(shadow).slot, 'FREE', 'PRECONDITION: a shadow does not occupy the work slot')
  assert.deepEqual(classifyPriorAttempts([shadow]), { kind: 'none' })
  // The control: the same row WITHOUT the basis is an orphan-sweep cancellation and also frees the key, and a real queued row does not.
  assert.deepEqual(classifyPriorAttempts([{ ...shadow, settlementBasis: null }]), { kind: 'none' })
  assert.equal(classifyPriorAttempts([{ ...shadow, status: 'PENDING', settlementBasis: null, abandonedBeforeRemoteCall: null }]).kind, 'live')
  // A shadow beside a queued row changes nothing about the queued row's verdict.
  assert.equal(classifyPriorAttempts([shadow, { id: 'row-live', status: 'PENDING', externalTransactionId: null, abandonedBeforeRemoteCall: null, settlementBasis: null }]).kind, 'live')
})
