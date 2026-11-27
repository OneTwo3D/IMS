import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { MINTSOFT_POLL_NEEDS_KEY_TEXT } from '../lib/connectors/mintsoft/api/auth-no-login'

/**
 * A no-login refusal (username/password mode, stored key expired) says nothing about the event. It must not
 * spend the event's retry budget (eight failed attempts dead-letter it), and must leave an operator-visible
 * warning. An ordinary failure still counts, as the control.
 */
const updates: Array<Record<string, unknown>> = []
const logs: Array<{ action: string; level?: string; description: string }> = []
let attempts = 7

mock.module('@/lib/db', {
  namedExports: {
    db: {
      wmsInboundReceiptEvent: {
        findUnique: async (args: { select: Record<string, boolean> }) =>
          args.select.processedAt
            ? { id: 'e1', externalAsnId: 'ASN-1', processedAt: null }
            : { processingAttempts: attempts },
        update: async ({ data }: { data: Record<string, unknown> }) => { updates.push(data); return {} },
        // Step 3b (MED-6): a failure for another reason ends the episode of waits on the purchase rate (a no-op here: nothing was waiting).
        updateMany: async () => ({ count: 0 }),
      },
      wmsAsnMap: { findUnique: async () => ({ id: 'm1' }) },
    },
  },
})
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (e: { action: string; level?: string; description: string }) => { logs.push(e) } },
})
mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { recordWmsMutationEvent: async () => undefined } })

test('a login refusal does not consume the retry budget and raises the key-expired warning', async () => {
  updates.length = 0; logs.length = 0; attempts = 7
  const { processBookedInEvent } = await import('../lib/domain/wms/booked-in-service')
  const result = await processBookedInEvent('e1', {
    fetchRemoteAsn: async () => { throw new Error(`Mintsoft request failed with status 401 ${MINTSOFT_POLL_NEEDS_KEY_TEXT}`) },
  })
  assert.equal(result.status, 'failed')
  assert.equal((result as { loginRefused?: boolean }).loginRefused, true)
  assert.equal(updates.length, 1)
  assert.equal('processingAttempts' in updates[0]!, false, 'attempts must be left alone')
  assert.equal(updates[0]!.deadLetteredAt, null, 'the 8th attempt must not dead-letter it')
  assert.equal(updates[0]!.processingStatus, 'FAILED_RETRY')
  assert.ok(updates[0]!.nextRetryAt instanceof Date)
  const warning = logs.find((l) => l.action === 'mintsoft_booked_in_key_expired')
  assert.ok(warning)
  assert.equal(warning.level, 'WARNING')
  assert.match(warning.description, /Mintsoft key expired, run a manual sync to refresh it/)
})

test('control: an ordinary failure still counts an attempt and dead-letters at the limit', async () => {
  updates.length = 0; logs.length = 0; attempts = 7
  const { processBookedInEvent } = await import('../lib/domain/wms/booked-in-service')
  const result = await processBookedInEvent('e1', { fetchRemoteAsn: async () => { throw new Error('boom') } })
  assert.equal(result.status, 'failed')
  assert.equal(updates[0]!.processingAttempts, 8)
  assert.ok(updates[0]!.deadLetteredAt instanceof Date)
})
