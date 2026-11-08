import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { AccountingSyncType } from '@/app/generated/prisma/client'
import {
  XERO_OBLIGATION_SOURCES,
  xeroObligationAt,
  xeroProducerSeamVerdict,
  xeroResolveObligationAt,
  type ObligationParentReader,
} from '@/lib/domain/accounting/xero-producer-seam'
import { buildInventoryAdjustmentJournal } from '@/lib/domain/inventory/stock-adjustment-apply'
import { buildLandedCostCogsJournalPayload, buildLandedCostReclassJournalPayload } from '@/lib/domain/purchasing/landed-cost-service'
import { buildPurchaseInvoiceAccountingPayload } from '@/lib/domain/purchasing/purchase-invoice-edit'
import { buildSupplierCreditNoteSyncPayload } from '@/lib/domain/purchasing/supplier-credit-note'
import { buildShipmentCogsRevaluationSyncPayload } from '@/lib/cost-layers'
import { OUTBOUND_GRANT_ENV } from '@/lib/security/outbound-write-hold-constants'
import { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV } from '@/lib/security/producer-disposition-constants'
import { ACCOUNTING_SYNC_TYPE_EXCLUSIONS, WRITER_OWNERSHIP_MAP, type OwnershipRow } from '@/lib/security/writer-ownership-map'

/**
 * THE BUSINESS-EVENT TIME OF EVERY ACCOUNTING SYNC TYPE, PINNED.
 *
 * A type whose payload carries no readable date is SHADOW (`obligation_time_required`) at the live phase even with every grant set: the
 * safe direction, but a producer IMS owns from then on would silently never go live. So every type declares where its time comes from
 * (XERO_OBLIGATION_SOURCES), the declaration is checked against the ownership map, and the real payload of each producer is shown to
 * carry it.
 *
 * Named mutations (each shown red in the PR): a  a producer drops its `date`; b  a follow-up stops inheriting its parent's time;
 * c  the census forgets a type; d  date-only read as end of day instead of start.
 */

const ALL_TYPES = Object.values(AccountingSyncType) as string[]
const mapRowFor = (type: string): OwnershipRow | undefined =>
  (WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]).find((row) => (row.accountingSyncTypes ?? []).includes(type))

test('CENSUS: every AccountingSyncType declares its obligation source, consistently with the ownership map; nothing stale is declared', () => {
  const declared = Object.keys(XERO_OBLIGATION_SOURCES)
  assert.deepEqual([...declared].sort(), [...ALL_TYPES].sort(), 'the table covers exactly the enum')
  for (const type of ALL_TYPES) {
    const source = XERO_OBLIGATION_SOURCES[type as AccountingSyncType]
    const excluded = Object.prototype.hasOwnProperty.call(ACCOUNTING_SYNC_TYPE_EXCLUSIONS, type)
    assert.equal(source.kind === 'excluded', excluded, `${type}: excluded iff it is in ACCOUNTING_SYNC_TYPE_EXCLUSIONS`)
    if (excluded) continue
    const row = mapRowFor(type)
    assert.ok(row, `${type} is in the ownership map`)
    if (source.kind === 'not-applicable') assert.equal(row!.obligationTime, 'not-applicable', `${type}: declared not-applicable but the map requires a time`)
    else assert.equal(row!.obligationTime, 'required', `${type}: declared ${source.kind} but the map says ${row!.obligationTime}`)
  }
  assert.deepEqual(Object.entries(XERO_OBLIGATION_SOURCES).filter(([, s]) => s.kind === 'dead').map(([t]) => t), ['STOCK_ALLOCATION'])
  assert.deepEqual(Object.entries(XERO_OBLIGATION_SOURCES).filter(([, s]) => s.kind === 'parent').map(([t]) => t).sort(), ['BILL_ATTACHMENT', 'WC_INVOICE_NOTE'])
  // Every declared chain is short, ends at a dated payload-sourced ancestor and only passes through types that are not themselves dated writes.
  for (const [type, source] of Object.entries(XERO_OBLIGATION_SOURCES)) {
    if (source.kind !== 'parent') continue
    assert.ok(source.via.length >= 1 && source.via.length <= 3, `${type}: chain depth is bounded`)
    source.via.forEach((hop, index) => {
      assert.ok(hop.length > 0, `${type}: hop ${index} names a type`)
      for (const hopType of hop) {
        assert.ok(ALL_TYPES.includes(hopType), `${type}: ${hopType} is a sync type`)
        const hopSource = XERO_OBLIGATION_SOURCES[hopType]
        if (index === source.via.length - 1) assert.equal(hopSource.kind, 'payload', `${type}: the last hop ${hopType} is a dated ancestor`)
        else assert.equal(hopSource.kind, 'excluded', `${type}: intermediate hop ${hopType} is a non-write row`)
      }
    })
  }
  assert.deepEqual(XERO_OBLIGATION_SOURCES.WC_INVOICE_NOTE, { kind: 'parent', via: [['INVOICE_PDF'], ['SALES_INVOICE', 'SALES_INVOICE_UPDATE']] })
  assert.deepEqual(XERO_OBLIGATION_SOURCES.BILL_ATTACHMENT, { kind: 'parent', via: [['PURCHASE_INVOICE', 'PURCHASE_INVOICE_UPDATE']] })
})

test('the types Xeroom owns in every phase never go LIVE, so their obligation source cannot gate a posting', () => {
  for (const type of ['SALES_INVOICE', 'SALES_INVOICE_UPDATE', 'CREDIT_NOTE']) {
    const row = mapRowFor(type)!
    assert.notEqual(row.owners.P2, 'IMS', type)
  }
})

const DAY = '2026-06-02'

function fieldOf(type: string): string {
  const source = XERO_OBLIGATION_SOURCES[type as AccountingSyncType]
  assert.equal(source.kind, 'payload', type)
  return (source as { kind: 'payload'; field: string }).field
}

test('REAL BUILDERS: the payload each exported producer builds carries the declared date field, read back by xeroObligationAt', () => {
  const day = (type: string, payload: unknown) => {
    const field = fieldOf(type)
    const record = payload as Record<string, unknown>
    assert.equal(typeof record[field], 'string', `${type}: payload has ${field}`)
    assert.ok(xeroObligationAt(payload), `${type}: xeroObligationAt reads it`)
  }
  const bill = buildPurchaseInvoiceAccountingPayload({ poReference: 'PO-1', contactName: 'S', date: DAY, currency: 'GBP', fxRateToBase: 1, lines: [] })
  day('PURCHASE_INVOICE', bill)
  day('PURCHASE_INVOICE_UPDATE', bill)
  assert.equal(xeroObligationAt(bill)?.toISOString(), `${DAY}T00:00:00.000Z`)
  day('PURCHASE_CREDIT_NOTE', buildSupplierCreditNoteSyncPayload({
    creditNoteId: 'cn-1', creditNoteNumber: 'CN-1', reference: null, reason: null, supplierName: 'S', supplierId: 's-1', currency: 'GBP', fxRateToBase: 1,
    amountForeign: 5, transitAccount: '600', taxType: 'NONE', date: DAY,
  }))
  const reval = buildShipmentCogsRevaluationSyncPayload({ shipmentId: 'sh-1', costLayerId: 'cl-1', inventoryAccount: '630', cogsAccount: '310', oldCogsBase: 4, newCogsBase: 6 })
  assert.ok(reval)
  day('COGS_REVERSAL', reval)
  day('INVENTORY_ADJUSTMENT', buildInventoryAdjustmentJournal({
    reasonAccountCode: '300', inventoryAccountCode: '630', productSku: 'SKU', productName: 'P', warehouseCode: 'W', warehouseName: 'W', qty: 1, totalValueBase: 5,
  } as Parameters<typeof buildInventoryAdjustmentJournal>[0]))
  day('STOCK_IN_TRANSIT', buildLandedCostReclassJournalPayload({ primaryPoRef: 'PO-1', absDelta: 5, isIncrease: true, inventoryAccount: '630', transitAccount: '840' }))
  day('COGS_JOURNAL', buildLandedCostCogsJournalPayload({ primaryPoRef: 'PO-1', absDelta: 5, isIncrease: false, cogsAccount: '310', offsetAccount: '840' }))
  // The decrease branches keep the date too (the payload is one literal, but pin both directions).
  assert.ok(xeroObligationAt(buildLandedCostReclassJournalPayload({ primaryPoRef: 'PO-1', absDelta: 5, isIncrease: false, inventoryAccount: '630', transitAccount: '840' })))
})

/**
 * Producers that build their payload inline. The literal is pinned in place: the declared field must sit in the payload object that is enqueued
 * under that type. (Extracting every one of them would be a money-path refactor for a date key.)
 */
const INLINE_SITES: Array<{ types: string[]; file: string; pattern: RegExp }> = [
  { types: ['STOCK_RECEIPT'], file: 'app/actions/purchase-orders.ts', pattern: /date: new Date\(\)\.toISOString\(\)\.slice\(0, 10\),\n\s*reference: `Receipt: \$\{po\.reference\}`/ },
  { types: ['STOCK_RECEIPT'], file: 'lib/connectors/mintsoft/sync/stock-sync.ts', pattern: /date: now\.toISOString\(\)\.slice\(0, 10\),\n\s*reference: `Receipt: \$\{purchaseCost\.poReference\}`/ },
  { types: ['STOCK_RECEIPT'], file: 'lib/domain/wms/booked-in-service.ts', pattern: /date: now\.toISOString\(\)\.slice\(0, 10\),\n\s*reference: `Receipt: \$\{po\.reference\}`/ },
  { types: ['INVENTORY_ADJUSTMENT'], file: 'app/actions/purchase-orders.ts', pattern: /date: new Date\(\)\.toISOString\(\)\.slice\(0, 10\),\n\s*reference: returnRef,/ },
  { types: ['BILL_PAYMENT'], file: 'app/actions/purchase-orders.ts', pattern: /paymentDate: input\.paymentDate,/ },
  { types: ['INVOICE_PAYMENT'], file: 'lib/domain/accounting/invoice-payment-enqueue.ts', pattern: /paymentDate: params\.paidAt\.toISOString\(\)\.slice\(0, 10\),/ },
  { types: ['PURCHASE_CREDIT_NOTE_ALLOCATION'], file: 'lib/connectors/xero/sync-processor.ts', pattern: /date: \(payload\.date as string \| undefined\)\?\.slice\(0, 10\)/ },
  { types: ['ALLOCATION_REVERSAL'], file: 'lib/domain/sales/allocation-service.ts', pattern: /date: new Date\(\)\.toISOString\(\)\.slice\(0, 10\),\n\s*reference: `Allocation reversal: \$\{orderRef\}`/ },
  { types: ['MANUFACTURING_JOURNAL'], file: 'app/actions/manufacturing.ts', pattern: /date: now\.toISOString\(\)\.slice\(0, 10\),\n\s*reference,/ },
  { types: ['MANUFACTURING_RECLASS'], file: 'app/actions/manufacturing.ts', pattern: /date: new Date\(\)\.toISOString\(\)\.slice\(0, 10\),\n\s*reference: `MFG-RECLASS: \$\{po\.reference\}`/ },
  { types: ['COGS_REVERSAL'], file: 'lib/domain/sales/refund-service.ts', pattern: /date: cogsReversalJournalDate,/ },
  { types: ['UNEARNED_REV_REVERSAL'], file: 'lib/domain/sales/refund-service.ts', pattern: /date: new Date\(\)\.toISOString\(\)\.slice\(0, 10\),\n\s*reference: hasUnearnedReversal/ },
  { types: ['DAILY_BATCH_INVENTORY_RECONCILIATION'], file: 'lib/connectors/xero/daily-sync.ts', pattern: /date: journal\.date,\n\s*reference: `Inventory reconciliation/ },
  { types: ['DAILY_BATCH_COGS_RECONCILIATION'], file: 'lib/connectors/xero/daily-sync.ts', pattern: /date: journal\.date,\n\s*reference: `COGS reconciliation/ },
  { types: ['DAILY_BATCH_TRANSIT_RECONCILIATION'], file: 'lib/connectors/xero/daily-sync.ts', pattern: /date: journal\.date,\n\s*reference: `Transit reconciliation/ },
  { types: ['DAILY_BATCH_REVENUE_DEFERRAL', 'DAILY_BATCH_INVENTORY_ALLOC', 'DAILY_BATCH_GROUP_B'], file: 'lib/connectors/xero/daily-sync.ts', pattern: /date: today,/ },
]

test('INLINE PRODUCERS: the declared date field sits in the payload each producer enqueues, and every declared payload type is covered by a builder test or a pinned site', () => {
  const covered = new Set<string>([
    'PURCHASE_INVOICE', 'PURCHASE_INVOICE_UPDATE', 'PURCHASE_CREDIT_NOTE', 'COGS_REVERSAL', 'INVENTORY_ADJUSTMENT', 'STOCK_IN_TRANSIT', 'COGS_JOURNAL',
    // Xeroom-owned in every phase (never LIVE): their date cannot gate a posting, see the test above.
    'SALES_INVOICE', 'SALES_INVOICE_UPDATE', 'CREDIT_NOTE',
  ])
  for (const site of INLINE_SITES) {
    const text = readFileSync(path.join(process.cwd(), site.file), 'utf8')
    assert.match(text, site.pattern, `${site.file} must still build the payload for ${site.types.join(', ')} with its date`)
    for (const type of site.types) covered.add(type)
  }
  const needed = ALL_TYPES.filter((type) => XERO_OBLIGATION_SOURCES[type as AccountingSyncType].kind === 'payload')
  assert.deepEqual(needed.filter((type) => !covered.has(type)), [], 'every payload-sourced type is pinned by a builder test or an inline site')
})

const TENANT = '4f7f0c6e-1111-4222-8333-944455556666'
const SHOP = 'https://shop.example.test'
const LIVE_FROM = '2026-01-01T00:00:00Z'
const XERO_ENV = { [PRODUCER_HOLD_ENFORCED_ENV]: 'xero', [OUTBOUND_GRANT_ENV.xero]: TENANT, [PRODUCER_CUTOFF_ENV.xero]: LIVE_FROM }
const WOO_ENV = { [PRODUCER_HOLD_ENFORCED_ENV]: 'woocommerce', [OUTBOUND_GRANT_ENV.woocommerce]: SHOP, [PRODUCER_CUTOFF_ENV.woocommerce]: LIVE_FROM }
const NOW = new Date('2026-06-01T12:00:00Z')

type FakeRow = { type: string; payload: unknown }

function readerOf(rows: Record<string, FakeRow>): { client: ObligationParentReader; reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    client: { accountingSyncLog: { findUnique: async ({ where }) => { reads.push(where.id); return where.id in rows ? rows[where.id]! : null } } },
  }
}

test('VERDICT PER DECLARED KIND under a granted, enforced destination: after the cut-off LIVE, before it SHADOW, no date SHADOW obligation_time_required', () => {
  for (const type of ALL_TYPES) {
    const source = XERO_OBLIGATION_SOURCES[type as AccountingSyncType]
    if (source.kind !== 'payload') continue
    const row = mapRowFor(type)!
    const verdict = (date: string | undefined) => xeroProducerSeamVerdict({
      connector: 'xero', type, payload: date === undefined ? { amount: 1 } : { [source.field]: date }, env: XERO_ENV, now: NOW,
    })
    const none = verdict(undefined)
    assert.ok(none.kind === 'shadow', type)
    if (row.owners.P2 !== 'IMS') {
      assert.equal(none.decision.reason, 'not_ims_owned', type)
      continue
    }
    assert.equal(none.decision.reason, 'obligation_time_required', type)
    assert.equal(verdict('2026-05-30').kind, 'live', type)
    const early = verdict('2025-12-31')
    assert.ok(early.kind === 'shadow' && early.decision.reason === 'obligation_before_cutoff', type)
  }
})

test('FOLLOW-UPS INHERIT THE DATED ANCESTOR through their declared chain; a broken chain shadows even when the follow-up payload carries a post-cutoff date of its own', async () => {
  const DATED = '2026-05-30'
  const cases: Array<{ type: 'BILL_ATTACHMENT' | 'WC_INVOICE_NOTE'; env: Record<string, string>; chain: (date: string | undefined) => Record<string, FakeRow>; start: string; wrongTypeChain: Record<string, FakeRow> }> = [
    {
      type: 'WC_INVOICE_NOTE', env: WOO_ENV, start: 'pdf-1',
      chain: (date) => ({ 'pdf-1': { type: 'INVOICE_PDF', payload: { sourceEntryId: 'inv-1', accountingInvoiceId: 'x' } }, 'inv-1': { type: 'SALES_INVOICE', payload: date === undefined ? {} : { date } } }),
      wrongTypeChain: { 'pdf-1': { type: 'INVOICE_PDF', payload: { sourceEntryId: 'inv-1' } }, 'inv-1': { type: 'STOCK_RECEIPT', payload: { date: DATED } } },
    },
    {
      type: 'BILL_ATTACHMENT', env: XERO_ENV, start: 'bill-1',
      chain: (date) => ({ 'bill-1': { type: 'PURCHASE_INVOICE', payload: date === undefined ? {} : { date } } }),
      wrongTypeChain: { 'bill-1': { type: 'COGS_JOURNAL', payload: { date: DATED } } },
    },
  ]
  for (const c of cases) {
    // The follow-up's OWN payload names its source and also carries a date after the cut-off: it must never be what decides.
    const payload = { sourceEntryId: c.start, accountingInvoiceId: 'x', date: '2026-05-31', paymentDate: '2026-05-31', invoiceDate: '2026-05-31' }
    const decide = async (rows: Record<string, FakeRow>, p: unknown = payload) => {
      const { client, reads } = readerOf(rows)
      const obligationAt = await xeroResolveObligationAt(client, { type: c.type, payload: p, env: c.env })
      return { verdict: xeroProducerSeamVerdict({ connector: 'xero', type: c.type, payload: p, obligationAt, env: c.env, now: NOW }), reads, obligationAt }
    }
    const live = await decide(c.chain(DATED))
    assert.equal(live.verdict.kind, 'live', `${c.type}: dated ancestor after the cut-off`)
    assert.equal(live.obligationAt?.toISOString(), `${DATED}T00:00:00.000Z`, `${c.type}: it is the ANCESTOR's date, not the follow-up's own`)
    assert.ok(live.reads.length >= 1 && live.reads.length <= 2, `${c.type}: bounded reads ${live.reads}`)
    const early = await decide(c.chain('2025-12-31'))
    assert.ok(early.verdict.kind === 'shadow' && early.verdict.decision.reason === 'obligation_before_cutoff', `${c.type}: ancestor before the cut-off beats the follow-up's own later date`)
    const compacted = await decide(c.chain(undefined))
    assert.ok(compacted.verdict.kind === 'shadow' && compacted.verdict.decision.reason === 'obligation_time_required', `${c.type}: compacted ancestor`)
    const gone = await decide({})
    assert.ok(gone.verdict.kind === 'shadow' && gone.verdict.decision.reason === 'obligation_time_required', `${c.type}: source row missing`)
    const wrongType = await decide(c.wrongTypeChain)
    assert.ok(wrongType.verdict.kind === 'shadow' && wrongType.verdict.decision.reason === 'obligation_time_required', `${c.type}: an unexpected type in the chain is a broken link`)
    const noLink = await decide(c.chain(DATED), { accountingInvoiceId: 'x', date: '2026-05-31' })
    assert.ok(noLink.verdict.kind === 'shadow' && noLink.verdict.decision.reason === 'obligation_time_required', `${c.type}: no sourceEntryId, own date ignored`)
  }
  // The verdict itself never falls back to the follow-up's own payload date when no resolved value is handed over (MUTATION: `obligationAt ?? payload` => LIVE => red).
  const unresolved = xeroProducerSeamVerdict({ connector: 'xero', type: 'BILL_ATTACHMENT', payload: { date: '2026-05-31', sourceEntryId: 'bill-1' }, env: XERO_ENV, now: NOW })
  assert.ok(unresolved.kind === 'shadow' && unresolved.decision.reason === 'obligation_time_required')
  // A cycle or a self-reference is a broken link.
  const cyc = readerOf({ 'a': { type: 'INVOICE_PDF', payload: { sourceEntryId: 'a' } } })
  assert.equal(await xeroResolveObligationAt(cyc.client, { type: 'WC_INVOICE_NOTE', payload: { sourceEntryId: 'a' }, env: WOO_ENV }), undefined)
  assert.deepEqual(cyc.reads, ['a'], 'a self-referencing row is read once, never looped')
  // No parent named, or a client that cannot read: no obligation, never a guess.
  assert.equal(await xeroResolveObligationAt({}, { type: 'BILL_ATTACHMENT', payload: { sourceEntryId: 'bill-1' }, env: XERO_ENV }), undefined)
  assert.equal(await xeroResolveObligationAt(readerOf({ 'bill-1': { type: 'PURCHASE_INVOICE', payload: { date: DATED } } }).client, { type: 'BILL_ATTACHMENT', payload: [{ sourceEntryId: 'bill-1' }], env: XERO_ENV }), undefined)
})

test('SWITCH OFF IS BYTE-IDENTICAL: with the hold not enforced the parent is never read and the verdict is legacy', async () => {
  const { client, reads } = readerOf({ 'parent-1': { type: 'PURCHASE_INVOICE', payload: { date: '2026-05-30' } } })
  for (const type of ['BILL_ATTACHMENT', 'WC_INVOICE_NOTE']) {
    const obligationAt = await xeroResolveObligationAt(client, { type, payload: { sourceEntryId: 'parent-1' }, env: {} })
    assert.equal(obligationAt, undefined)
    assert.deepEqual(xeroProducerSeamVerdict({ connector: 'xero', type, payload: { sourceEntryId: 'parent-1' }, obligationAt, env: {}, now: NOW }), { kind: 'legacy' })
  }
  assert.deepEqual(reads, [], 'no query when the hold is off')
  // A non-follow-up type is read from its payload without touching the client.
  assert.equal((await xeroResolveObligationAt(client, { type: 'PURCHASE_INVOICE', payload: { date: '2026-05-30' }, env: XERO_ENV }))?.toISOString(), '2026-05-30T00:00:00.000Z')
  assert.deepEqual(reads, [])
})

test('A DATE-ONLY OBLIGATION READS AS 00:00Z: with a mid-day live-from instant, work dated that same day is SHADOW (documented; set live-from to 00:00Z of the switch day)', () => {
  const midDay = { ...XERO_ENV, [PRODUCER_CUTOFF_ENV.xero]: '2026-06-02T10:00:00Z' }
  const now = new Date('2026-06-02T15:00:00Z')
  const sameDay = xeroProducerSeamVerdict({ connector: 'xero', type: 'PURCHASE_INVOICE', payload: { date: '2026-06-02' }, env: midDay, now })
  // MUTATION d: date-only read as end of day => LIVE => red.
  assert.ok(sameDay.kind === 'shadow' && sameDay.decision.reason === 'obligation_before_cutoff', 'same-day date-only work is before a mid-day instant')
  const withTime = xeroProducerSeamVerdict({ connector: 'xero', type: 'PURCHASE_INVOICE', payload: { date: '2026-06-02T11:30:00Z' }, env: midDay, now })
  assert.equal(withTime.kind, 'live', 'a full instant after the cut-off is live')
  const midnight = { ...XERO_ENV, [PRODUCER_CUTOFF_ENV.xero]: '2026-06-02T00:00:00Z' }
  assert.equal(xeroProducerSeamVerdict({ connector: 'xero', type: 'PURCHASE_INVOICE', payload: { date: '2026-06-02' }, env: midnight, now }).kind, 'live', 'with live-from at 00:00Z the same-day work is live')
  assert.ok(xeroProducerSeamVerdict({ connector: 'xero', type: 'PURCHASE_INVOICE', payload: { date: '2026-06-01' }, env: midnight, now }).kind === 'shadow', 'the day before is still the earlier writer\'s')
})
