import assert from 'node:assert/strict'
import test from 'node:test'

import { refreshShipmentCogsForCostLayerChange } from '@/lib/cost-layers'

/**
 * o3d-j625 r3 (Codex HIGH 1) — A DECLINED COGS_REVERSAL MUST NOT BE CLAIMED BY THE SUBLEDGER OR DROPPED
 * FROM THE COMPENSATING JOURNAL.
 *
 * `queueShipmentCogsRevaluationSync` discarded the enqueue's answer, recorded the COGS subledger
 * movement, and returned `true`. `true` is what `refreshShipmentCogsForCostLayerChange` reads to add the
 * shipment's delta to `cogsRevaluationDelta` — the amount its landed-cost caller REMOVES from the
 * retrospective COGS journal because the shipment path "owns" it. On a refusal (a retired chart), the GL
 * therefore received neither the COGS_REVERSAL nor the journal line covering its absence, while the COGS
 * subledger recorded a movement claiming it had.
 *
 * Every test here drives the REAL function with only the enqueue injected, and counts subledger writes
 * off the transaction double — the two effects the finding is about, observed directly.
 */

function transaction() {
  const subledger: unknown[] = []
  let aborted = false
  const tx = {
    // o3d-j625 r12 (merging o3d-c08y) — THE DOUBLE ANSWERS THE CONTEXT PROBE *AND* ABORTS FOR REAL.
    //
    // c08y refuses to run at all on a client where a below-zero refusal could not abort the enclosing
    // transaction, and its abort is `$executeRaw` on a statement that is MEANT to fail
    // (`SELECT CAST('<sentinel>' AS int)`); if that statement succeeds, c08y refuses rather than
    // continuing. So a double whose `$executeRaw` quietly returns 0 would not let a test route around the
    // guard — but it would also not EXERCISE it. This one behaves like the real client: the abort statement
    // THROWS, and every delegate afterwards throws 25P02, so a case that reached a refusal could not carry
    // on reading or writing. The shipments in this file are positive on both sides, so the refusal never
    // fires; if a future edit makes one negative, the test will fail loudly rather than silently pass.
    $executeRaw: async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      const sql = Array.isArray(strings) ? (strings as TemplateStringsArray).join('?') : String(strings)
      if (/CAST\(/i.test(sql)) {
        aborted = true
        throw Object.assign(new Error(`invalid input syntax for type integer: "${String(values[0] ?? '')}"`), { code: '22P02' })
      }
      return 0
    },
    $executeRawUnsafe: async (sql: string) => {
      if (aborted) throw Object.assign(new Error('current transaction is aborted, commands ignored until end of transaction block'), { code: '25P02' })
      if (!/^\s*(SAVEPOINT|RELEASE SAVEPOINT)\s/i.test(sql)) {
        throw new Error(`cost-layer-revaluation-declined-enqueue double: unexpected raw statement ${JSON.stringify(sql)}`)
      }
      return 0
    },
    $queryRawUnsafe: async () => [{ id: 'shipment-1' }],
    shipment: {
      findUnique: async () => ({
        cogsBatchAmount: '20.00',
        shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
        order: { id: 'order-1', accountingInvoiceId: 'INV-XERO-1' },
      }),
      update: async () => undefined,
    },
    shipmentLine: {
      findMany: async () => [{ costLayerSnapshot: [{ costLayerId: 'layer-1', qty: '5.000000', unitCostBase: '5.500000' }] }],
    },
    cogsSubledgerMovement: {
      upsert: async ({ create }: { create: unknown }) => { subledger.push(create); return create },
    },
  }
  return { tx, subledger }
}

const OPTIONS = {
  accountingSettings: { inventoryAccount: '120', cogsAccount: '500', connector: 'xero' as const },
  isReversalPostingEnabled: async () => true,
}

test('[o3d-j625 r3 HIGH 1] PRECONDITION: a QUEUED revaluation records one subledger movement and claims the 7.5 delta', async () => {
  const { tx, subledger } = transaction()
  let enqueues = 0
  const result = await refreshShipmentCogsForCostLayerChange(tx as never, 'layer-1', {
    ...OPTIONS,
    queueAccountingSync: async () => { enqueues++; return true },
  })
  assert.equal(enqueues, 1, 'the enqueue was reached')
  assert.equal(subledger.length, 1, 'the subledger mirrors a queued journal')
  assert.equal(result.cogsRevaluationDelta.toString(), '7.5', 'and the shipment path owns the delta')
})

test('[o3d-j625 r3 HIGH 1] a DECLINED revaluation records NO subledger movement and leaves the delta in the COGS journal', async () => {
  const { tx, subledger } = transaction()
  let enqueues = 0
  const result = await refreshShipmentCogsForCostLayerChange(tx as never, 'layer-1', {
    ...OPTIONS,
    // What `queueAccountingSyncTx` returns when `refuseUnattributableChart` refuses a retired chart.
    queueAccountingSync: async () => { enqueues++; return false },
  })
  assert.equal(enqueues, 1, 'PRECONDITION: the enqueue was reached — this is not the posting-disabled early return')
  assert.equal(subledger.length, 0, 'the subledger must not claim a movement the GL never received')
  assert.equal(
    result.cogsRevaluationDelta.toString(),
    '0',
    'the delta must stay in the caller’s retrospective COGS journal, or it posts nowhere',
  )
  assert.equal(result.shipmentsUpdated, 1, 'the shipment’s own cost is still refreshed — only the claim changes')
})
