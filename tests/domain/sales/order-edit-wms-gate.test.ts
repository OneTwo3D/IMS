import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveOrderEditWmsGate, type OrderEditWmsGateDeps } from '@/lib/domain/sales/order-edit-wms-gate'

type Link = Awaited<ReturnType<OrderEditWmsGateDeps['readLink']>>
const deps = (link: Link, probe: OrderEditWmsGateDeps['probe']): OrderEditWmsGateDeps & { probed: unknown[][] } => {
  const probed: unknown[][] = []
  return { readLink: async () => link, probe: async (...args) => { probed.push(args); return probe(...args) }, probed }
}
const pushed: Link = { connector: 'mintsoft', externalOrderId: 'MS-1', orderNumber: 'SO-1' }

test('an order the warehouse has no order for yet has nothing to amend: no probe, the edit may go ahead', async () => {
  for (const link of [null, { connector: 'mintsoft', externalOrderId: null, orderNumber: 'SO-1' }] as Link[]) {
    const d = deps(link, async () => { throw new Error('must not be asked') })
    assert.deepEqual(await resolveOrderEditWmsGate('o1', 'lines', d), { ok: true, externalOrderId: null })
    assert.equal(d.probed.length, 0)
  }
})

test('a pushed order whose warehouse order is still amendable may be edited; the gate is asked for exactly that order and number', async () => {
  const d = deps(pushed, async () => ({ amendable: true }))
  assert.deepEqual(await resolveOrderEditWmsGate('o1', 'lines', d), { ok: true, externalOrderId: 'MS-1' })
  assert.deepEqual(d.probed, [['mintsoft', 'MS-1', 'SO-1']])
})

test('a pushed order past NEW (or merged, or missing) in the warehouse is refused with AMENDMENT_NOT_APPLIED, for lines and for addresses', async () => {
  for (const status of ['NOT_NEW', 'MERGED_SURVIVOR', 'NOT_FOUND', 'ORDER_NUMBER_MISMATCH']) {
    for (const scope of ['lines', 'addresses and notes'] as const) {
      const r = await resolveOrderEditWmsGate('o1', scope, deps(pushed, async () => ({ amendable: false, status })))
      assert.equal(r.ok, false, `${status}/${scope}`)
      if (!r.ok) {
        assert.match(r.error, /^AMENDMENT_NOT_APPLIED:/)
        assert.match(r.error, new RegExp(status))
        assert.match(r.error, /nothing was changed/)
      }
    }
  }
})

test('an unknown warehouse state refuses: the read failing, or a connector that cannot answer, never reads as amendable', async () => {
  const failed = await resolveOrderEditWmsGate('o1', 'lines', deps(pushed, async () => { throw new Error('ECONNRESET') }))
  assert.equal(failed.ok, false)
  const unsupported = await resolveOrderEditWmsGate('o1', 'lines', deps(pushed, async () => 'unsupported'))
  assert.equal(unsupported.ok, false)
  if (!failed.ok) assert.doesNotMatch(failed.error, /ECONNRESET/, 'the transport error is not echoed')
})
