import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * THE PRODUCTION `applyDispatch` DEP CARRIES THE "STOREFRONT ALREADY HOLDS THIS" FLAG TO THE FULFILMENT BOUNDARY.
 *
 * The sweep core decides it; `createPrismaDispatchDeps(...).applyDispatch` must hand it to `applyExternalFulfillmentUpdate`,
 * or the completion job and the storefront push are requested for a storefront that is already complete. The boundary is a
 * recorder here; the database answers "nothing" for everything else.
 */

const updates: Array<Record<string, unknown>> = []
mock.module('@/lib/fulfillment/external-fulfillment', {
  namedExports: { applyExternalFulfillmentUpdate: async (update: Record<string, unknown>) => { updates.push(update); return { success: true } } },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined, logActivityPersisted: async () => true } })
mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { recordWmsMutationEvent: async () => undefined } })
mock.module('@/lib/db', {
  namedExports: {
    db: new Proxy({}, {
      get: (_t, prop: string) => (prop === 'then' ? undefined : new Proxy({}, { get: () => async () => null })),
    }),
  },
})

test('applyDispatch hands storefrontAlreadyCompleted to the boundary only when told to', async () => {
  const { createPrismaDispatchDeps } = await import('@/lib/domain/wms/dispatch-sweep')
  const deps = createPrismaDispatchDeps('mintsoft' as never, {} as never)
  await deps.applyDispatch('o1', [{ trackingNumber: 'T1' }], { storefrontAlreadyCompleted: true })
  await deps.applyDispatch('o1', [{ trackingNumber: 'T1' }])
  assert.equal(updates.length, 2, 'PRECONDITION: the boundary was reached both times')
  assert.equal(updates[0]!.storefrontAlreadyCompleted, true)
  assert.equal('storefrontAlreadyCompleted' in updates[1]!, false, 'an ordinary dispatch does not carry it')
})
