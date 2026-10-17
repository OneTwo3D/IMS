import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { OUTBOUND_GRANT_ENV, isOutboundWriteHeldText } from '@/lib/security/outbound-write-hold-constants'
import { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV } from '@/lib/security/producer-disposition-constants'

/**
 * THE MINTSOFT PRODUCER SEAM: THE DECISION PER OPERATION, THE CLEARANCE, THE PASS-LEVEL HOLD AND THE REFUSAL TEXT.
 *
 * Every arm runs the real code with the switch OFF (the default: the legacy behaviour, byte for byte) and ON with no grant (the
 * P0/P1 posture: nothing may be produced and no state may change), and, where the question is what the live phase does, ON with
 * every condition for LIVE. Mintsoft is LIVE and nothing here talks to a network: tests/no-outbound-network.cjs makes a request
 * that would leave the box a failure, and the shadow store is a recording client. The database facts (the unique key, the
 * transaction the shadow commits with, retention) are proved against a real Postgres in tests/db/mintsoft-producer-seam.test.ts.
 *
 * Named mutations (shown red in the PR, restored from a copy, md5-verified):
 *  a  seam-answers-live          mintsoftProducerSeam proceeds with no grant: the SHADOW arms go red
 *  b  shadow-hands-out-clearance the generic seam returns a clearance for a shadow: the "no clearance on a shadow" arm goes red
 *  c  payload-built-eagerly      the seam evaluates a payload thunk on the proceed path: the lazy-payload arm goes red
 *  d  refusal-text-unreferenced  the barrier's text loses its hold reference: the "a queue recognises it as a hold" arm goes red
 */

const GRANT = 'https://wms.example.test|89'
const ENV_KEYS = [PRODUCER_HOLD_ENFORCED_ENV, OUTBOUND_GRANT_ENV.mintsoft, PRODUCER_CUTOFF_ENV.mintsoft, 'SETTINGS_ENCRYPTION_KEY']
const ON = { [PRODUCER_HOLD_ENFORCED_ENV]: 'mintsoft' }
const LIVE = { ...ON, [OUTBOUND_GRANT_ENV.mintsoft]: GRANT, [PRODUCER_CUTOFF_ENV.mintsoft]: '2026-06-01T00:00:00Z' }

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

type ShadowCall = { destination: unknown; operation: unknown; subjectType: unknown; subjectId: unknown }
function shadowClient(options: { fails?: boolean; occurrences?: number } = {}) {
  const calls: ShadowCall[] = []
  const client = {
    $queryRaw: async (query: { strings?: readonly string[]; values?: readonly unknown[] }) => {
      const text = (query.strings ?? []).join('?')
      if (!text.includes('outbound_shadow_writes')) return []
      if (options.fails) throw new Error('relation "outbound_shadow_writes" does not exist')
      const values = query.values ?? []
      calls.push({ destination: values[0], operation: values[1], subjectType: values[2], subjectId: values[3] })
      return [{ id: `shadow-${calls.length}`, inserted: calls.length === 1, occurrences: options.occurrences ?? calls.length, accounting_sync_log_id: null, sync_row_exists: false }]
    },
    $executeRaw: async () => 1,
  }
  return { client, calls }
}

/** A proceed answer carries the clearance every warehouse write needs; a shadow never does. */
function assertCleared(answer: { proceed: boolean }, message?: string): void {
  assert.equal(answer.proceed, true, message)
  assert.equal('clearance' in answer, true, message ? `${message}: a proceed carries a clearance` : 'a proceed carries a clearance')
}

const OPERATIONS = ['order.create', 'order.amend', 'order.cancel', 'order.hold', 'order.comment', 'product.upsert', 'product.content', 'product.bundle', 'asn.create'] as const

test('mintsoftProducerSeam: switch OFF proceeds for every operation and records nothing (the legacy path)', async () => {
  const { mintsoftProducerSeam } = await import('@/lib/connectors/mintsoft/producer-seam')
  await withEnv({}, async () => {
    const { client, calls } = shadowClient()
    for (const operation of OPERATIONS) {
      const answer = await mintsoftProducerSeam({ operation, subjectType: 'X', subjectId: 'y', payload: {}, client })
      assertCleared(answer, operation)
    }
    assert.equal(calls.length, 0)
  })
})

test('mintsoftProducerSeam: ON for ANOTHER destination leaves Mintsoft untouched; a misspelt value enforces every destination', async () => {
  const { mintsoftProducerSeam } = await import('@/lib/connectors/mintsoft/producer-seam')
  await withEnv({ [PRODUCER_HOLD_ENFORCED_ENV]: 'xero,woocommerce' }, async () => {
    assertCleared(await mintsoftProducerSeam({ operation: 'order.create', subjectType: 'O', subjectId: '1', payload: {}, client: shadowClient().client }))
  })
  await withEnv({ [PRODUCER_HOLD_ENFORCED_ENV]: 'mintsof' }, async () => {
    const { client, calls } = shadowClient()
    const answer = await mintsoftProducerSeam({ operation: 'order.create', subjectType: 'O', subjectId: '1', payload: {}, client })
    assert.equal(answer.proceed, false)
    assert.equal(calls.length, 1)
  })
})

test('mintsoftProducerSeam: ON and no grant is a SHADOW with its own outcome for EVERY operation, recorded once each, naming the owner', async () => {
  const { mintsoftProducerSeam } = await import('@/lib/connectors/mintsoft/producer-seam')
  await withEnv(ON, async () => {
    const { client, calls } = shadowClient({ occurrences: 4 })
    const owners: Record<string, RegExp> = {
      'order.create': /the WooCommerce-Mintsoft plugin/,
      'order.amend': /the WooCommerce-Mintsoft plugin/,
      'order.comment': /an operator working by hand/,
      'asn.create': /an operator working by hand/,
      'product.upsert': /the WooCommerce-Mintsoft plugin/,
      'product.bundle': /the WooCommerce-Mintsoft plugin/,
    }
    for (const operation of OPERATIONS) {
      const answer = await mintsoftProducerSeam({ operation, subjectType: 'Thing', subjectId: `id-${operation}`, payload: { operation }, client })
      assert.equal(answer.proceed, false, operation)
      if (answer.proceed) continue
      assert.equal(answer.shadowed, true)
      assert.equal(answer.reason, 'no_grant')
      assert.equal(answer.recorded, true)
      assert.equal(answer.occurrences, 4)
      assert.match(answer.notice, /^Not sent by IMS: writes to Mintsoft are held on this installation/)
      assert.match(answer.notice, /IMS kept a shadow record of what it would have written and queued nothing/)
      if (owners[operation]) assert.match(answer.notice, owners[operation]!, operation)
    }
    console.log(`# shadows recorded: ${calls.map((call) => String(call.operation)).join(', ')}`)
    assert.deepEqual(calls.map((call) => [call.destination, call.operation]), OPERATIONS.map((operation) => ['mintsoft', operation]))
  })
})

test('mintsoftProducerSeam: a shadow whose RECORD fails is still a shadow (lost evidence, never lost work) and never throws', async () => {
  const { mintsoftProducerSeam } = await import('@/lib/connectors/mintsoft/producer-seam')
  const errors = mock.method(console, 'error', () => undefined)
  try {
    await withEnv(ON, async () => {
      const answer = await mintsoftProducerSeam({ operation: 'order.create', subjectType: 'SalesOrder', subjectId: 'o-1', payload: {}, client: shadowClient({ fails: true }).client })
      assert.equal(answer.proceed, false)
      if (!answer.proceed) {
        assert.equal(answer.recorded, false)
        assert.equal(answer.occurrences, null)
      }
      assert.equal(errors.mock.callCount(), 1, 'the lost record is logged loudly')
    })
  } finally {
    errors.mock.restore()
  }
})

test('mintsoftProducerSeam: the payload thunk is evaluated ONLY for a shadow, and one that throws is recorded as unbuildable (the shadow is still kept)', async () => {
  const { mintsoftProducerSeam } = await import('@/lib/connectors/mintsoft/producer-seam')
  let built = 0
  const thunk = () => { built += 1; return { sku: 'A' } }
  await withEnv({}, async () => {
    await mintsoftProducerSeam({ operation: 'order.create', subjectType: 'O', subjectId: '1', payload: thunk, client: shadowClient().client })
    assert.equal(built, 0, 'OFF: the legacy path builds nothing extra')
  })
  await withEnv(LIVE, async () => {
    const answer = await mintsoftProducerSeam({ operation: 'order.cancel', subjectType: 'O', subjectId: '1', payload: thunk, client: shadowClient().client })
    assertCleared(answer)
    assert.equal(built, 0, 'LIVE: a proceed builds nothing for the digest')
  })
  await withEnv(ON, async () => {
    const { client, calls } = shadowClient()
    await mintsoftProducerSeam({ operation: 'order.create', subjectType: 'O', subjectId: '1', payload: thunk, client })
    assert.equal(built, 1, 'SHADOW: built once, for the digest')
    const throwing = await mintsoftProducerSeam({ operation: 'order.create', subjectType: 'O', subjectId: '2', payload: () => { throw new Error('no street line') }, client })
    assert.equal(throwing.proceed, false)
    if (!throwing.proceed) assert.equal(throwing.recorded, true, 'an unbuildable payload is still a recorded shadow')
    assert.equal(calls.length, 2)
  })
})

test('mintsoftProducerSeam: in the live phase IMS-owned operations proceed; the ones that need a business-event time are shadows without it and before the live-from instant', async () => {
  const { mintsoftProducerSeam } = await import('@/lib/connectors/mintsoft/producer-seam')
  await withEnv(LIVE, async () => {
    const { client } = shadowClient()
    for (const operation of ['order.cancel', 'order.hold', 'order.comment', 'product.upsert', 'product.bundle', 'asn.create', 'product.content'] as const) {
      assertCleared(await mintsoftProducerSeam({ operation, subjectType: 'X', subjectId: '1', payload: {}, client }), operation)
    }
    const noTime = await mintsoftProducerSeam({ operation: 'order.create', subjectType: 'O', subjectId: '1', payload: {}, client })
    assert.equal(noTime.proceed, false)
    if (!noTime.proceed) assert.equal(noTime.reason, 'obligation_time_required')
    const before = await mintsoftProducerSeam({ operation: 'order.amend', subjectType: 'O', subjectId: '1', payload: {}, client, obligationAt: new Date('2026-05-31T23:59:59Z') })
    assert.equal(before.proceed, false)
    if (!before.proceed) assert.equal(before.reason, 'obligation_before_cutoff')
    const after = await mintsoftProducerSeam({ operation: 'order.create', subjectType: 'O', subjectId: '1', payload: {}, client, obligationAt: new Date('2026-06-01T00:00:00Z') })
    assertCleared(after, 'an order paid at the instant belongs to IMS')
    const resolved = await mintsoftProducerSeam({ operation: 'order.create', subjectType: 'O', subjectId: '1', payload: {}, client, resolveObligationAt: async () => new Date('2026-07-01T00:00:00Z') })
    assertCleared(resolved)
    const throwingResolver = await mintsoftProducerSeam({ operation: 'order.create', subjectType: 'O', subjectId: '1', payload: {}, client, resolveObligationAt: async () => { throw new Error('db down') } })
    assert.equal(throwingResolver.proceed, false, 'a resolver that fails leaves the time absent, which is a shadow: unreadable is never live')
  })
})

test('mintsoftProducerSeam: the lazy time resolver is NOT called when the hold is not enforced for Mintsoft (no extra read on a legacy installation)', async () => {
  const { mintsoftProducerSeam } = await import('@/lib/connectors/mintsoft/producer-seam')
  let reads = 0
  await withEnv({}, async () => {
    await mintsoftProducerSeam({ operation: 'order.create', subjectType: 'O', subjectId: '1', payload: {}, resolveObligationAt: async () => { reads += 1; return new Date() } })
  })
  assert.equal(reads, 0)
})

test('wmsProducerSeam (the generic seam): a shadow has no clearance, a proceed has one, an unregistered connector is not governed', async () => {
  const { wmsProducerSeam } = await import('@/lib/connectors/wms/producer-seam')
  await withEnv(ON, async () => {
    const { client, calls } = shadowClient()
    const shadow = await wmsProducerSeam('mintsoft', { operation: 'order.create', subjectType: 'SalesOrder', subjectId: 'o-1', payload: {}, client })
    assert.equal(shadow.proceed, false)
    assert.equal('clearance' in shadow, false, 'a shadow carries no clearance: the compiler makes the caller handle it before it can write')
    assert.equal(calls.length, 1)
    const foreign = await wmsProducerSeam('acme-wms', { operation: 'order.create', subjectType: 'SalesOrder', subjectId: 'o-1', payload: {}, client })
    assert.equal(foreign.proceed, true, 'a connector this build does not register has no ownership map: unchanged behaviour')
    assert.equal(calls.length, 1, 'and nothing was recorded for it')
  })
  await withEnv({}, async () => {
    const answer = await wmsProducerSeam('mintsoft', { operation: 'order.create', subjectType: 'SalesOrder', subjectId: 'o-1', payload: {}, client: shadowClient().client })
    assert.equal(answer.proceed, true)
    assert.equal('clearance' in answer, true)
  })
})

test('wmsProducerHold / mintsoftDrainHold: legacy and the live phase are open, everything else is held with the reason; a registered-or-not connector id', async () => {
  const { wmsProducerHold } = await import('@/lib/connectors/wms/producer-seam')
  await withEnv({}, async () => assert.deepEqual(wmsProducerHold('mintsoft'), { held: false }))
  await withEnv(LIVE, async () => assert.deepEqual(wmsProducerHold('mintsoft'), { held: false }))
  await withEnv(ON, async () => {
    const hold = wmsProducerHold('mintsoft')
    assert.equal(hold.held, true)
    if (hold.held) {
      assert.equal(hold.reason, 'no_grant')
      assert.match(hold.notice, /^Not sent by IMS: writes to Mintsoft are held/)
      assert.match(hold.queuedNotice, /This queued entry was handed back unsent/)
    }
    assert.deepEqual(wmsProducerHold('acme-wms'), { held: false })
  })
  await withEnv({ ...LIVE, [PRODUCER_CUTOFF_ENV.mintsoft]: '2999-01-01T00:00:00Z' }, async () => assert.equal(wmsProducerHold('mintsoft').held, true, 'a future instant is a scheduled flip'))
  await withEnv({ ...LIVE, [PRODUCER_CUTOFF_ENV.mintsoft]: '2026-06-01' }, async () => assert.equal(wmsProducerHold('mintsoft').held, true, 'an unreadable instant is held'))
  await withEnv({ [PRODUCER_HOLD_ENFORCED_ENV]: 'xero' }, async () => assert.deepEqual(wmsProducerHold('mintsoft'), { held: false }))
})

test('the transport barrier text is a complete outbound-write hold text: a queue that recognises a hold recognises it, and nothing else does', async () => {
  const { mintsoftEgressRefusalText, mintsoftEgressHold } = await import('@/lib/connectors/mintsoft/producer-egress')
  await withEnv({ ...ON, SETTINGS_ENCRYPTION_KEY: 'a1'.repeat(32) }, async () => {
    const hold = mintsoftEgressHold()
    assert.equal(hold.held, true)
    if (!hold.held) return
    const text = mintsoftEgressRefusalText(hold, { method: 'PUT', target: '/api/Order' })
    console.log(`# barrier text: ${text.slice(0, 160)}...`)
    assert.match(text, /^Outbound write HELD \(Mintsoft\)/)
    assert.match(text, /PUT \/api\/Order was refused before it left IMS, so nothing was sent to Mintsoft/)
    assert.equal(isOutboundWriteHeldText(text), true, 'recognised as a hold, so no attempt is spent on it')
    assert.equal(isOutboundWriteHeldText(`${text.slice(0, -4)}f]`), false, 'a tampered reference is not')
    assert.equal(isOutboundWriteHeldText('Mintsoft said: Outbound write HELD (Mintsoft): nothing'), false, 'a vendor-chosen text is not')
  })
})

test('the sentence a shadow carries names the owner and does not claim anything about Mintsoft', async () => {
  const { mintsoftProducerSeam } = await import('@/lib/connectors/mintsoft/producer-seam')
  await withEnv(ON, async () => {
    const answer = await mintsoftProducerSeam({ operation: 'order.create', subjectType: 'O', subjectId: '1', payload: {}, client: shadowClient().client })
    assert.equal(answer.proceed, false)
    if (answer.proceed) return
    assert.match(answer.notice, /This does not say whether the WooCommerce-Mintsoft plugin has written it to Mintsoft: check Mintsoft before acting\.$/)
    assert.doesNotMatch(answer.notice, /already exists|does not exist/i)
  })
})
