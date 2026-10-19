import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyIncumbentMeta, readWcPaidTime } from '../../lib/domain/incumbent-evidence/classify'
import {
  EVIDENCE_MAX_IN_FLIGHT,
  incumbentEvidenceStats,
  recordWcIncumbentEvidence,
  resetIncumbentEvidenceStats,
  settleWcIncumbentEvidence,
  startWcIncumbentEvidence,
} from '../../lib/domain/incumbent-evidence/record'

/**
 * WHAT THE STOREFRONT IMPORT KEEPS ABOUT OTHER WRITERS. Pure classification, plus the best-effort recorder over injected writers.
 */

type Written = { externalOrderId: string; kind: string; paidAt: Date | null }

function harness(options: { failWrite?: boolean; failUnrecorded?: boolean } = {}) {
  const written: Written[] = []
  const unrecorded: Array<{ kinds: string[]; paidState: string; paidAt: Date | null; reason: string }> = []
  return {
    written,
    unrecorded,
    deps: {
      write: async (input: Written) => { if (options.failWrite) throw new Error('db down'); written.push(input) },
      unrecorded: async (input: (typeof unrecorded)[number]) => { if (options.failUnrecorded) throw new Error('log down'); unrecorded.push(input) },
    },
  }
}

test('classification: the bridge id, other bridge metas and the invoicing plugin are told apart; empty marks are not evidence', () => {
  const kinds = (meta: unknown) => { const result = classifyIncumbentMeta(meta); assert.ok(result.ok); return result.ok ? result.kinds : [] }
  assert.deepEqual(kinds([{ key: '_mintsoft_order_id', value: '12345' }]), ['MINTSOFT_ORDER_ID'])
  assert.deepEqual(kinds([{ key: '_mintsoft_split_from', value: 77 }, { key: '_mintsoft_merged_into', value: 'x' }]), ['MINTSOFT_OTHER_META'])
  assert.deepEqual(kinds([{ key: 'xeroom_invoice_id', value: 'abc' }, { key: '_Xeroom_status', value: 'sent' }]), ['XEROOM_MARKER'])
  assert.deepEqual(kinds([{ key: '_mintsoft_order_id', value: '' }, { key: '_mintsoft_order_id', value: null }, { key: '_mintsoft_order_id', value: 0 }, { key: '_mintsoft_order_id', value: ' 0 ' }]), [])
  // Not evidence: the PDF plugin's own number (the invoicing plugin only READS it) and unrelated keys.
  assert.deepEqual(kinds([{ key: '_wcpdf_invoice_number', value: '1001' }, { key: 'mintsoft_order_id', value: '5' }, { key: '_billing_vat', value: 'x' }]), [])
  assert.deepEqual(kinds([{ key: '_mintsoft_order_id', value: '5' }, { key: 'xeroom_x', value: 'y' }, { key: 'other', value: 1 }]), ['MINTSOFT_ORDER_ID', 'XEROOM_MARKER'])
  assert.deepEqual(kinds([]), [], 'a list that is present and holds no mark is legitimately empty')
  assert.deepEqual(kinds([{ key: 'unrelated' }]), [], 'an unrelated key with no value field cannot be a mark')
  // FAIL CLOSED: anything that cannot be shown to carry no mark is unreadable, never "empty".
  const unreadable = (meta: unknown) => assert.equal(classifyIncumbentMeta(meta).ok, false, JSON.stringify(meta) ?? String(meta))
  for (const meta of [undefined, null, {}, 'x', 5, [null], [3], [{ value: 'k' }], [{ key: 5, value: 'k' }], [[]], [{ key: '_mintsoft_order_id' }], [{ key: 'xeroom_x' }], [{ key: '_mintsoft_split_from' }], [{ key: 'unrelated', value: 1 }, 7]]) unreadable(meta)
  assert.equal(classifyIncumbentMeta({ not: 'a list' }).ok, false)
  assert.equal(classifyIncumbentMeta('text').ok, false)
})

test('paid time: read as UTC (never the host zone); unpaid and unreadable are different answers', () => {
  const at = (state: ReturnType<typeof readWcPaidTime>) => (state.state === 'paid' ? state.at.toISOString() : state.state)
  assert.equal(at(readWcPaidTime('2026-10-05T10:00:00')), '2026-10-05T10:00:00.000Z')
  assert.equal(at(readWcPaidTime('2026-10-05 10:00:00')), '2026-10-05T10:00:00.000Z')
  assert.equal(at(readWcPaidTime('2026-10-05T10:00:00Z')), '2026-10-05T10:00:00.000Z')
  assert.equal(at(readWcPaidTime('2026-10-05T12:00:00+02:00')), '2026-10-05T10:00:00.000Z')
  assert.equal(at(readWcPaidTime(null)), 'unpaid')
  assert.equal(at(readWcPaidTime(undefined)), 'unreadable', 'an absent field is a partial payload, not an unpaid order')
  assert.equal(at(readWcPaidTime('')), 'unpaid')
  for (const bad of ['yesterday', '2026-13-45T00:00:00', 12345, {}, '2026-10-05']) assert.equal(at(readWcPaidTime(bad)), 'unreadable', String(bad))
})

test('recorder: an ordinary order costs no write; a marked order writes one row per kind with the UTC paid time', async () => {
  const plain = harness()
  assert.deepEqual(await recordWcIncumbentEvidence({ id: 1, meta_data: [{ key: '_billing_vat', value: 'x' }], date_paid_gmt: '2026-10-05T10:00:00' }, plain.deps), { recorded: 0 })
  assert.equal(plain.written.length, 0)

  const marked = harness()
  const result = await recordWcIncumbentEvidence({ id: 42, meta_data: [{ key: '_mintsoft_order_id', value: '9' }, { key: 'xeroom_id', value: 'a' }], date_paid_gmt: '2026-10-05T10:00:00' }, marked.deps)
  assert.deepEqual(result, { recorded: 2 })
  assert.deepEqual(marked.written.map((row) => [row.externalOrderId, row.kind, row.paidAt?.toISOString()]), [
    ['42', 'MINTSOFT_ORDER_ID', '2026-10-05T10:00:00.000Z'],
    ['42', 'XEROOM_MARKER', '2026-10-05T10:00:00.000Z'],
  ])

  const unpaid = harness()
  await recordWcIncumbentEvidence({ id: 43, meta_data: [{ key: '_mintsoft_order_id', value: '9' }], date_paid_gmt: null }, unpaid.deps)
  assert.equal(unpaid.written[0]?.paidAt, null, 'an unpaid order is kept with no paid time, so it is not counted until it is paid')
})

test('recorder FAIL CLOSED: an unreadable paid time, an unreadable meta list or a failed write is logged as unrecorded and never throws', async () => {
  const badPaid = harness()
  assert.deepEqual(await recordWcIncumbentEvidence({ id: 1, meta_data: [{ key: '_mintsoft_order_id', value: '9' }], date_paid_gmt: 'garbage' }, badPaid.deps), { recorded: 0, unrecorded: true })
  assert.equal(badPaid.written.length, 0)
  assert.deepEqual(badPaid.unrecorded.map((u) => [u.kinds, u.paidState]), [[['MINTSOFT_ORDER_ID'], 'unreadable']])

  const badMeta = harness()
  assert.deepEqual(await recordWcIncumbentEvidence({ id: 2, meta_data: { oops: true }, date_paid_gmt: '2026-10-05T10:00:00' }, badMeta.deps), { recorded: 0, unrecorded: true })
  assert.equal(badMeta.unrecorded.length, 1)

  const failing = harness({ failWrite: true })
  assert.deepEqual(await recordWcIncumbentEvidence({ id: 3, meta_data: [{ key: '_mintsoft_order_id', value: '9' }], date_paid_gmt: '2026-10-05T10:00:00' }, failing.deps), { recorded: 0, unrecorded: true })
  assert.deepEqual(failing.unrecorded.map((u) => [u.kinds, u.paidState, u.paidAt?.toISOString()]), [[['MINTSOFT_ORDER_ID'], 'paid', '2026-10-05T10:00:00.000Z']])

  // Even the log failing does not throw into the import.
  const both = harness({ failWrite: true, failUnrecorded: true })
  assert.deepEqual(await recordWcIncumbentEvidence({ id: 4, meta_data: [{ key: '_mintsoft_order_id', value: '9' }], date_paid_gmt: '2026-10-05T10:00:00' }, both.deps), { recorded: 0, unrecorded: true })
})

const MARKED = (id: number) => ({ id, meta_data: [{ key: '_mintsoft_order_id', value: '9' }], date_paid_gmt: '2026-10-15T10:00:00' })

test('OFF THE CRITICAL PATH: starting the evidence returns at once even when the write never finishes; the attempt then ends at its deadline, is counted, and is logged as unrecorded', async () => {
  resetIncumbentEvidenceStats()
  const unrecorded: Array<{ reason: string; kinds: string[] }> = []
  const deps = {
    write: () => new Promise<void>(() => {}), // a write blocked forever on the table
    unrecorded: async (input: { reason: string; kinds: string[] }) => { unrecorded.push(input) },
    deadlineMs: 40,
  }
  const before = Date.now()
  const returned = startWcIncumbentEvidence(MARKED(1), deps as never)
  assert.equal(returned, undefined, 'there is no promise for the caller to await')
  assert.ok(Date.now() - before < 20, 'the start itself does not wait for the write')
  assert.equal(unrecorded.length, 0, 'nothing is decided yet')
  await settleWcIncumbentEvidence()
  assert.deepEqual(unrecorded.map((u) => [u.reason, u.kinds]), [['EvidenceDeadline', ['MINTSOFT_ORDER_ID']]])
  assert.equal(incumbentEvidenceStats.timedOut, 1)
  assert.equal(incumbentEvidenceStats.recorded, 0)
})

test('the awaitable recorder is bounded too: a hanging write returns unrecorded at the deadline instead of hanging', async () => {
  const unrecorded: unknown[] = []
  const result = await recordWcIncumbentEvidence(MARKED(2), { write: () => new Promise<void>(() => {}), unrecorded: async (i) => { unrecorded.push(i) }, deadlineMs: 30 })
  assert.deepEqual(result, { recorded: 0, unrecorded: true })
  assert.equal(unrecorded.length, 1)
  // A hanging unrecorded-log writer is bounded as well.
  const both = await recordWcIncumbentEvidence(MARKED(3), { write: () => new Promise<void>(() => {}), unrecorded: () => new Promise<void>(() => {}), deadlineMs: 30 })
  assert.deepEqual(both, { recorded: 0, unrecorded: true })
})

test('failures are counted: a failing write counts as failed, a good one as recorded; an unmarked order counts neither', async () => {
  resetIncumbentEvidenceStats()
  const h = harness({ failWrite: true })
  startWcIncumbentEvidence(MARKED(4), h.deps as never)
  startWcIncumbentEvidence({ id: 5, meta_data: [], date_paid_gmt: null }, h.deps as never)
  const ok = harness()
  startWcIncumbentEvidence(MARKED(6), ok.deps as never)
  await settleWcIncumbentEvidence()
  assert.equal(incumbentEvidenceStats.failed, 1)
  assert.equal(incumbentEvidenceStats.recorded, 1, 'the unmarked order has nothing to write and counts as neither')
  assert.equal(h.unrecorded.length, 1)
})

test('background attempts are capped: past the cap an attempt is not started and is logged as unrecorded, never queued without bound', async () => {
  resetIncumbentEvidenceStats()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const unrecorded: Array<{ reason: string }> = []
  const deps = { write: () => gate, unrecorded: async (i: { reason: string }) => { unrecorded.push(i) }, deadlineMs: 5_000 }
  for (let i = 0; i < EVIDENCE_MAX_IN_FLIGHT + 3; i += 1) startWcIncumbentEvidence(MARKED(100 + i), deps as never)
  assert.equal(incumbentEvidenceStats.dropped, 3)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(unrecorded.filter((u) => /in flight/.test(u.reason)).length, 3)
  release()
  await settleWcIncumbentEvidence()
  assert.equal(incumbentEvidenceStats.recorded, EVIDENCE_MAX_IN_FLIGHT)
})

test('recorder: a payload that cannot be proven to carry no marks is a GAP; a present list with no marks is not', async () => {
  const gap = async (order: Record<string, unknown>) => {
    const h = harness()
    const result = await recordWcIncumbentEvidence(order as never, h.deps)
    return { result, unrecorded: h.unrecorded.length, written: h.written.length }
  }
  for (const order of [{ id: 1, date_paid_gmt: '2026-10-15T10:00:00' }, { id: 2, meta_data: null, date_paid_gmt: '2026-10-15T10:00:00' }, { id: 3, meta_data: [null], date_paid_gmt: '2026-10-15T10:00:00' }]) {
    assert.deepEqual(await gap(order), { result: { recorded: 0, unrecorded: true }, unrecorded: 1, written: 0 }, JSON.stringify(order))
  }
  // A marked order with no paid field at all is a gap (the paid time cannot be read); with no id it is a gap too.
  assert.equal((await gap({ id: 4, meta_data: [{ key: '_mintsoft_order_id', value: '9' }] })).unrecorded, 1)
  assert.equal((await gap({ meta_data: [{ key: '_mintsoft_order_id', value: '9' }], date_paid_gmt: '2026-10-15T10:00:00' })).unrecorded, 1)
  assert.equal((await gap({ meta_data: [], date_paid_gmt: null })).unrecorded, 1)
  assert.deepEqual(await gap({ id: 5, meta_data: [], date_paid_gmt: '2026-10-15T10:00:00' }), { result: { recorded: 0 }, unrecorded: 0, written: 0 })
})
