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

function lockClient(flag: () => string | null, log: string[]) {
  return {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $executeRaw: async (q: TemplateStringsArray) => { log.push(`lock:${q.join('').includes('_shared') ? 'shared' : 'other'}`) },
      setting: { findUnique: async () => { log.push('flag-read'); const v = flag(); return v === null ? null : { value: v } } },
    }),
  }
}

test('delivery boundary: the shared lock is taken, then the flag re-read, then the send', async () => {
  const { runUnderPoEmailSendLock } = await import('../../lib/purchase-order-email.ts')
  const log: string[] = []
  const out = await runUnderPoEmailSendLock(lockClient(() => 'true', log), async () => { log.push('send'); return 'sent' })
  assert.deepEqual(out, { value: 'sent' })
  assert.deepEqual(log, ['lock:shared', 'flag-read', 'send'])
})

test('delivery boundary: flag turned OFF between preparation and send sends nothing', async () => {
  const { runUnderPoEmailSendLock, buildPurchaseOrderEmail } = await import('../../lib/purchase-order-email.ts')
  const { PO_EMAIL_DISABLED_REASON } = await import('../../lib/domain/purchasing/po-document.ts')
  void buildPurchaseOrderEmail
  // Preparation saw ON (it ran earlier); by the time the send is reached the committed value is OFF.
  let flag: string | null = 'true'
  const log: string[] = []
  flag = 'false' // the operator's save commits after preparation
  let sends = 0
  const out = await runUnderPoEmailSendLock(lockClient(() => flag, log), async () => { sends++; return 'sent' })
  assert.deepEqual(out, { refused: PO_EMAIL_DISABLED_REASON })
  assert.equal(sends, 0)
  assert.deepEqual(log, ['lock:shared', 'flag-read'])
  // An absent row is OFF too.
  flag = null
  assert.deepEqual(await runUnderPoEmailSendLock(lockClient(() => flag, []), async () => { sends++ }), { refused: PO_EMAIL_DISABLED_REASON })
  assert.equal(sends, 0)
})
