import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// The settings row and the order read are doubles: no database is touched.
let settingValue: string | null = null
const settingKeys: string[] = []
let orderReads = 0
const dbDouble = {
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) => {
      settingKeys.push(where.key)
      return settingValue === null ? null : { value: settingValue }
    },
  },
  purchaseOrder: { findUnique: async () => { orderReads++; throw new Error('the order must not be read') } },
}
mock.module('@/lib/db', { namedExports: { db: dbDouble, prisma: dbDouble } })

test('the flag is OFF unless the setting is exactly "true"', async () => {
  const { isPurchaseOrderEmailEnabled } = await import('../../lib/purchase-order-email.ts')
  const { PO_EMAIL_SETTING_KEY } = await import('../../lib/domain/purchasing/po-document.ts')
  for (const [value, expected] of [[null, false], ['false', false], ['', false], ['TRUE', false], ['true', true]] as const) {
    settingValue = value
    settingKeys.length = 0
    assert.equal(await isPurchaseOrderEmailEnabled(), expected, String(value))
    assert.deepEqual(settingKeys, [PO_EMAIL_SETTING_KEY])
  }
})

test('the drain refuses a PURCHASE_ORDER row while the flag is OFF, before reading the order', async () => {
  const { prepareQueuedEmail } = await import('../../lib/order-email.ts')
  const { EmailKindDisabledError } = await import('../../lib/email-kind-disabled.ts')
  const { PO_EMAIL_DISABLED_REASON } = await import('../../lib/domain/purchasing/po-document.ts')
  settingValue = 'false'
  await assert.rejects(
    () => prepareQueuedEmail('PURCHASE_ORDER', 'PurchaseOrder', 'po-1'),
    (e: unknown) => e instanceof EmailKindDisabledError && e.message === PO_EMAIL_DISABLED_REASON,
  )
  assert.equal(orderReads, 0)
})

test('with the flag ON the drain goes on to read the order (the refusal is gone)', async () => {
  const { prepareQueuedEmail } = await import('../../lib/order-email.ts')
  settingValue = 'true'
  await assert.rejects(() => prepareQueuedEmail('PURCHASE_ORDER', 'PurchaseOrder', 'po-1'), /must not be read|PO not found/)
  assert.ok(orderReads > 0)
})
