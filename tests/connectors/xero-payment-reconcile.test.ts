import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyDoc,
  fetchInvoiceStatusesByIds,
  reconcileLinkedInvoices,
  RECONCILE_BATCH_SIZE,
  type LinkedDoc,
  type ReconcileDeps,
  type XeroReconcileInvoice,
} from '@/lib/connectors/xero/payment-reconcile'

function doc(over: Partial<LinkedDoc> = {}): LinkedDoc {
  return { id: 'o1', accountingInvoiceId: 'INV-1', imsPaid: false, imsAdvanced: false, label: 'order 1', ...over }
}
const xero = (status: string, fullyPaid?: string): XeroReconcileInvoice => ({ InvoiceID: 'INV-1', Status: status, FullyPaidOnDate: fullyPaid })

// --- classifyDoc: the load-bearing decision ---------------------------------

test('IMS unpaid + Xero PAID = a missed payment to collect', () => {
  const v = classifyDoc(doc({ imsPaid: false }), xero('PAID', '2026-07-01T00:00:00Z'))
  assert.equal(v.kind, 'missed-payment')
  assert.equal(v.kind === 'missed-payment' && v.xero.Status, 'PAID')
})

test('IMS paid + Xero PAID = consistent, nothing to do', () => {
  assert.equal(classifyDoc(doc({ imsPaid: true }), xero('PAID')).kind, 'consistent')
})

test('IMS unpaid + Xero AUTHORISED = consistent (correctly unpaid)', () => {
  assert.equal(classifyDoc(doc({ imsPaid: false }), xero('AUTHORISED')).kind, 'consistent')
})

test('IMS paid + Xero AUTHORISED = suspect advance (the o3d-1d9 signal)', () => {
  const v = classifyDoc(doc({ imsPaid: true }), xero('AUTHORISED'))
  assert.equal(v.kind, 'suspect-advance')
  assert.equal(v.kind === 'suspect-advance' && v.xeroStatus, 'AUTHORISED')
})

test('IMS advanced but unpaid + Xero not PAID = suspect advance', () => {
  // An order moved to PROCESSING as if paid, but Xero never marked its invoice PAID.
  assert.equal(classifyDoc(doc({ imsPaid: false, imsAdvanced: true }), xero('AUTHORISED')).kind, 'suspect-advance')
})

test('IMS paid + Xero VOIDED = suspect advance (paid against a voided invoice)', () => {
  assert.equal(classifyDoc(doc({ imsPaid: true }), xero('VOIDED')).kind, 'suspect-advance')
})

test('Xero returns nothing for the id = unknown, never assumed unpaid', () => {
  // A deleted/never-existent id must NOT be treated as "AUTHORISED" and silently ignored.
  assert.equal(classifyDoc(doc(), undefined).kind, 'unknown')
})

// --- fetchInvoiceStatusesByIds: batching + failure ---------------------------

test('ids are batched, deduped, and keyed lowercased', async () => {
  const calls: string[] = []
  const ids = Array.from({ length: RECONCILE_BATCH_SIZE + 5 }, (_, i) => `INV-${i}`)
  ids.push('INV-0') // duplicate

  const res = await fetchInvoiceStatusesByIds(ids, async (path) => {
    calls.push(path)
    const requested = path.split('IDs=')[1].split(',')
    return { ok: true, status: 200, data: { Invoices: requested.map((id) => ({ InvoiceID: id, Status: 'PAID' })) } }
  })

  assert.equal(res.ok, true)
  assert.equal(calls.length, 2, 'RECONCILE_BATCH_SIZE+5 unique ids span two batches')
  // First batch is exactly the cap; duplicate collapsed.
  assert.equal(calls[0].split('IDs=')[1].split(',').length, RECONCILE_BATCH_SIZE)
  assert.ok(res.ok && res.statuses.has('inv-0'), 'keyed by lowercased id')
})

test('a failed batch aborts the whole fetch — never reconcile a partial picture', async () => {
  let n = 0
  const res = await fetchInvoiceStatusesByIds(
    Array.from({ length: RECONCILE_BATCH_SIZE + 1 }, (_, i) => `INV-${i}`),
    async () => (++n === 1 ? { ok: false, status: 429, error: 'Rate limited' } : { ok: true, status: 200, data: {} }),
  )
  assert.equal(res.ok, false)
  assert.match(res.ok === false ? res.error : '', /Rate limited/)
})

test('an id Xero omits from the batch is simply absent (→ unknown downstream)', async () => {
  const res = await fetchInvoiceStatusesByIds(['A', 'B'], async () => ({
    ok: true, status: 200, data: { Invoices: [{ InvoiceID: 'A', Status: 'PAID' }] }, // B omitted
  }))
  assert.equal(res.ok, true)
  assert.equal(res.ok && res.statuses.has('a'), true)
  assert.equal(res.ok && res.statuses.has('b'), false)
})

// --- reconcileLinkedInvoices: orchestration + apply gate ---------------------

function makeDeps(over: Partial<ReconcileDeps> & { docs: Array<LinkedDoc & { kind: 'sales' | 'bill' }>; statuses: Map<string, XeroReconcileInvoice> }): {
  deps: ReconcileDeps
  marked: string[]
} {
  const marked: string[] = []
  const deps: ReconcileDeps = {
    loadLinkedDocs: async () => over.docs,
    fetchStatuses: async () => ({ ok: true, statuses: over.statuses }),
    markPaid: async (d) => { marked.push(d.id) },
    now: () => new Date('2026-07-17T00:00:00Z'),
    ...over,
  }
  return { deps, marked }
}

test('report mode categorises but mutates nothing', async () => {
  const docs = [
    { kind: 'sales' as const, ...doc({ id: 'missed', accountingInvoiceId: 'M', imsPaid: false }) },
    { kind: 'sales' as const, ...doc({ id: 'suspect', accountingInvoiceId: 'S', imsPaid: true }) },
    { kind: 'bill' as const, ...doc({ id: 'ok', accountingInvoiceId: 'K', imsPaid: true }) },
    { kind: 'bill' as const, ...doc({ id: 'gone', accountingInvoiceId: 'G', imsPaid: false }) },
  ]
  const statuses = new Map<string, XeroReconcileInvoice>([
    ['m', xero('PAID')], ['s', xero('AUTHORISED')], ['k', xero('PAID')], // 'g' absent
  ])
  const { deps, marked } = makeDeps({ docs, statuses })

  const r = await reconcileLinkedInvoices(deps, { apply: false })

  assert.equal(r.checked, 4)
  assert.deepEqual(r.missedPayments.map((m) => m.id), ['missed'])
  assert.equal(r.missedPayments[0].applied, false, 'report mode never applies')
  assert.deepEqual(r.suspectAdvances.map((s) => s.id), ['suspect'])
  assert.deepEqual(r.unknown.map((u) => u.id), ['gone'])
  assert.equal(marked.length, 0, 'report mode marks nothing paid')
})

test('apply mode collects missed payments and records that it did', async () => {
  const docs = [{ kind: 'sales' as const, ...doc({ id: 'missed', accountingInvoiceId: 'M' }) }]
  const statuses = new Map([['m', xero('PAID', '2026-07-01T00:00:00Z')]])
  const { deps, marked } = makeDeps({ docs, statuses })

  const r = await reconcileLinkedInvoices(deps, { apply: true })

  assert.deepEqual(marked, ['missed'])
  assert.equal(r.missedPayments[0].applied, true)
  assert.equal(r.missedPayments[0].paidDate, '2026-07-01T00:00:00.000Z', 'uses Xero FullyPaidOnDate')
})

test('apply mode NEVER auto-touches a suspect advance — reported only', async () => {
  const docs = [{ kind: 'sales' as const, ...doc({ id: 'suspect', accountingInvoiceId: 'S', imsPaid: true }) }]
  const { deps, marked } = makeDeps({ docs, statuses: new Map([['s', xero('AUTHORISED')]]) })

  const r = await reconcileLinkedInvoices(deps, { apply: true })

  assert.equal(r.suspectAdvances.length, 1)
  assert.equal(marked.length, 0, 'a suspect advance must never be auto-reverted or re-marked')
})

test('a markPaid failure is recorded and does not abort the sweep', async () => {
  const docs = [
    { kind: 'sales' as const, ...doc({ id: 'boom', accountingInvoiceId: 'A', label: 'order BOOM' }) },
    { kind: 'sales' as const, ...doc({ id: 'ok', accountingInvoiceId: 'B', label: 'order OK' }) },
  ]
  const statuses = new Map([['a', xero('PAID')], ['b', xero('PAID')]])
  const { deps } = makeDeps({ docs, statuses })
  deps.markPaid = async (d) => { if (d.id === 'boom') throw new Error('db down'); }

  const r = await reconcileLinkedInvoices(deps, { apply: true })

  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0], /order BOOM.*db down/)
  assert.equal(r.missedPayments.find((m) => m.id === 'ok')?.applied, true, 'the other one still applied')
})

test('a Xero fetch failure aborts with an error and applies nothing', async () => {
  const docs = [{ kind: 'sales' as const, ...doc({ id: 'x', accountingInvoiceId: 'A' }) }]
  const { deps, marked } = makeDeps({ docs, statuses: new Map() })
  deps.fetchStatuses = async () => ({ ok: false, error: 'Xero down' })

  const r = await reconcileLinkedInvoices(deps, { apply: true })

  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0], /Xero down/)
  assert.equal(r.missedPayments.length, 0)
  assert.equal(marked.length, 0)
})

test('an empty population is a clean no-op (no fetch)', async () => {
  let fetched = false
  const { deps } = makeDeps({ docs: [], statuses: new Map() })
  deps.fetchStatuses = async () => { fetched = true; return { ok: true, statuses: new Map() } }

  const r = await reconcileLinkedInvoices(deps, { apply: true })

  assert.equal(r.checked, 0)
  assert.equal(fetched, false, 'nothing to reconcile → do not call Xero at all')
})
