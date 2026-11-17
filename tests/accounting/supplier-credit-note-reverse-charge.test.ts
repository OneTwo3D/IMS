import { isLockedPluginSelectionRead, lockedPluginSelectionRows } from '../helpers/plugin-selection-double.ts'
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'

/**
 * A SUPPLIER CREDIT AGAINST A REVERSE-CHARGE BILL CARRIES THE BILL'S NET PAYABLE END TO END. Driven through the real server action and the real accounting facade, on the harness of
 * supplier-credit-note-chart-verdict.test.ts, with every HTTP call mocked (nothing here can reach Xero). A reverse-charge line of net 100 at 20% is 120 in IMS (it includes the VAT the bill
 * accounts for itself) but 100 in Xero and owed to the supplier: the credit is capped at the net payable, and one amount is the Xero credit lines (exclusive net, the booked code), the
 * allocation to the bill and the transit movement.
 */

let enabledPlugins: string[] = ['xero']
let pluginReads = 0
let flipAfterReads: { reads: number; to: string[] } | null = null
let xeroSync = 'true'

mock.module('@/lib/integration-plugins', {
  namedExports: {
    isIntegrationPluginEnabled: async (id: string) => {
      const answer = enabledPlugins.includes(id)
      pluginReads++
      if (flipAfterReads && pluginReads >= flipAfterReads.reads) enabledPlugins = flipAfterReads.to
      return answer
    },
  },
})
mock.module('@/lib/connectors/xero/settings', {
  namedExports: {
    getXeroSettings: async () => ({
      xero_sync_enabled: xeroSync,
      xero_sync_purchase_credit_note: 'submitted',
      xero_transit_account: 'X-TRANSIT',
      xero_inventory_account: 'X-INV',
    }),
  },
})
// o3d-j625 r12 (merging o3d-remove-parked-connectors): the SECOND CONNECTOR'S SETTINGS MOCK WAS HERE, and
// removing it is not cosmetic — `mock.module` RESOLVES its specifier, so a mock of an archived module makes
// the whole file fail to load with ERR_MODULE_NOT_FOUND. Every case that needed the second connector's
// chart is adapted or removed above/below, each saying which.
mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({ user: { id: 'u1', email: 'u@example.test', name: 'U', role: 'ADMIN', supplierId: null, sessionInvalidReason: null, totpEnabled: false, totpVerified: false } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } })
const activity: Array<{ action: string; metadata?: Record<string, unknown> }> = []
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; metadata?: Record<string, unknown> }) => { activity.push(entry) },
    logActivityPersisted: async () => true,
  },
})
// The facade's in-transaction enqueue collaborators — doubled exactly as chart-connector-routing.test.ts
// doubles them, so a refusal is attributable to the chart check and not to an order-lock guard.
mock.module('@/lib/domain/accounting/enqueue-order-guard', {
  namedExports: {
    resolveAccountingEnqueueOrderScope: async () => ({ scope: 'none' as const }),
    lockOrderForAccountingEnqueue: async () => false,
    findStaleOrderLevelDiscount: async () => null,
    logStaleOrderDiscountEnqueue: async () => undefined,
  },
})
mock.module('@/lib/connectors/accounting-id-provenance', { namedExports: { activeAccountingIdProvenance: async () => ({}) } })
mock.module('@/lib/connectors/accounting-connection-provenance', {
  namedExports: {
    stampAccountingPayloadConnection: (payload: Record<string, unknown>) => payload,
    mintAccountingConnectionProvenanceColumn: () => null,
  },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', { namedExports: { mirrorAccountingSyncLogToEvent: async () => undefined } })
mock.module('@/lib/connectors/xero/outbox', { namedExports: { scheduleXeroAccountingOutbox: async () => undefined } })
mock.module('@/lib/domain/accounting/followup-scope-lock', { namedExports: { lockFollowUpScope: async () => undefined } })
mock.module('@/lib/db/savepoint', { namedExports: { withSavepoint: async <T>(_tx: unknown, fn: () => Promise<T>): Promise<T> => fn() } })
const transit: Array<{ sourceType: string; baseDelta: number }> = []
mock.module('@/lib/domain/accounting/transit-subledger-movement', { namedExports: { recordTransitSubledgerMovement: async (_tx: unknown, row: { sourceType: string; baseDelta: number }) => { transit.push({ sourceType: row.sourceType, baseDelta: row.baseDelta }) } } })

const committed = { posted: 0, syncRows: [] as Array<{ connector: string; type: string }>, payloads: [] as Array<Record<string, unknown>> }
// What the stored rate rows and the connected organisation say (the credit's checks read them).
let inactiveRateRows: Array<{ id: string; name: string }> = []
let otherCredits: string | null = null
let ledgerTenant: string | null = null
let ledgerRates: Array<{ taxType: string; effectiveRate: number }> = []

let CREDIT_NOTE: Record<string, unknown> = {
  id: 'cn-1', poId: 'po-1', supplierId: 'sup-1', currency: 'GBP', fxRateToBase: new Prisma.Decimal('1'),
  amountForeign: new Prisma.Decimal('20'), creditNoteNumber: 'CN-1', reference: null, reason: null, status: 'DRAFT',
  purchaseInvoice: null,
  po: { reference: 'PO-1', type: 'GOODS', supplier: { name: 'Supplier', taxRate: null }, lines: [], freightCostLines: [] },
}

function transactionClient(pending: Array<() => void>) {
  // Any model the enqueue reads that this file does not model answers "nothing there" — a missing
  // delegate would otherwise throw and the control case would fail for a reason unrelated to the gate.
  const empty = { findFirst: async () => null, findUnique: async () => null, findMany: async () => [], count: async () => 0 }
  const modelled = {
    supplierCreditNote: {
      updateMany: async () => { pending.push(() => { committed.posted++ }); return { count: 1 } },
    },
    accountingSyncLog: {
      findMany: async () => [],
      findFirst: async () => null,
      create: async ({ data }: { data: { connector: string; type: string; payload?: Record<string, unknown> } }) => {
        pending.push(() => { committed.syncRows.push({ connector: data.connector, type: data.type }); committed.payloads.push(data.payload ?? {}) })
        return { id: 'log-1', ...data }
      },
    },
    activityLog: { create: async () => ({ id: 'a-1' }) },
    $executeRaw: async () => 1,
    // o3d-j625 r13: the selection FENCE now runs on every enqueue (see tests/helpers/plugin-selection-double.ts).
    // Answered from `enabledPlugins`, the same source the `isIntegrationPluginEnabled` mock above answers
    // from, so this fixture cannot hold two disagreeing notions of which connector is active.
    $queryRaw: async (query: TemplateStringsArray) => (
      isLockedPluginSelectionRead(query) ? lockedPluginSelectionRows(enabledPlugins) : []
    ),
  }
  return new Proxy(modelled as Record<string, unknown>, {
    get: (target, key: string) => (key in target ? target[key] : empty),
  })
}

const dbModelled: Record<string, unknown> = {
  supplierCreditNote: { findUnique: async () => CREDIT_NOTE, aggregate: async () => ({ _sum: { amountForeign: otherCredits === null ? null : new Prisma.Decimal(otherCredits) } }) },
  setting: { findUnique: async () => null },
  accountingToken: { findFirst: async () => null, findUnique: async () => (ledgerTenant === null ? null : { tenantId: ledgerTenant }) },
  taxRate: { findMany: async ({ where }: { where: { id?: { in: string[] }; active?: boolean } }) => (where.id ? inactiveRateRows.filter((r) => where.id!.in.includes(r.id)) : []) },
  xeroTaxRate: { findMany: async () => ledgerRates },
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const pending: Array<() => void> = []
    const result = await fn(transactionClient(pending))
    for (const apply of pending) apply()
    return result
  },
}
mock.module('@/lib/db', {
  namedExports: {
    // Unmodelled models answer "nothing there", for the reason given on the transaction client.
    db: new Proxy(dbModelled, {
      get: (target, key: string) => (key in target
        ? target[key]
        : { findFirst: async () => null, findUnique: async () => null, findMany: async () => [], count: async () => 0 }),
    }),
  },
})


const baseCredit = (amount: string, lines: Array<Record<string, unknown>>, taxForeign = '20', accountingInvoiceId: string | null = null) => ({
  id: 'cn-1', poId: 'po-1', supplierId: 'sup-1', currency: 'GBP', fxRateToBase: new Prisma.Decimal('1'), purchaseInvoiceId: 'inv-1',
  amountForeign: new Prisma.Decimal(amount), creditNoteNumber: 'CN-1', reference: null, reason: null, status: 'DRAFT',
  purchaseInvoice: { subtotalForeign: new Prisma.Decimal('100'), taxForeign: new Prisma.Decimal(taxForeign), accountingInvoiceId, accountingInvoiceConnector: accountingInvoiceId ? 'xero' : null, lines },
  po: { reference: 'PO-1', type: 'GOODS', taxRatePercent: null, taxRateName: null, supplier: { name: 'Supplier', taxRate: null }, lines: [], freightCostLines: [] },
})
const snapshot = (over: Record<string, unknown>) => ({ poLineId: null, costLineId: null, totalForeign: new Prisma.Decimal('100'), taxBookedAt: new Date(), taxType: 'INPUT2', taxRateValue: new Prisma.Decimal('0.2'), taxRateId: 'r-std', taxReverseCharge: false, ...over })
const rcLine = snapshot({ taxType: 'REVERSECHARGES', taxRateId: 'r-rc', taxReverseCharge: true })

function reset() {
  enabledPlugins = ['xero']
  pluginReads = 0
  flipAfterReads = null
  xeroSync = 'true'
  committed.posted = 0
  committed.syncRows = []
  committed.payloads = []
  inactiveRateRows = []
  otherCredits = null
  transit.length = 0
  ledgerTenant = null
  ledgerRates = []
  activity.length = 0
}

async function post() {
  const { postSupplierCreditNote } = await import('@/app/actions/purchase-orders')
  return postSupplierCreditNote('cn-1')
}

type XeroLine = { unitAmount: number; taxType: string; accountCode: string; taxRateId?: string }
type Queued = { lines: XeroLine[]; lineAmountsIncludeTax: boolean; allocateToInvoiceId?: string; allocateAmount?: number }
const queued = () => committed.payloads[0] as unknown as Queued
const round2 = (n: number) => Math.round(n * 100) / 100
const stdLine = snapshot({ totalForeign: new Prisma.Decimal('50') })

/**
 * The figures every reverse-charge credit must agree on. The Xero credit (exclusive) holds net plus the VAT Xero adds on STANDARD lines; reverse-charge VAT is self-accounted, so it posts a
 * debit and an equal credit on the VAT accounts and adds nothing to what is owed. The credit's journal is then Dr payables (the credit total) = Cr transit (the nets) + Cr input VAT (standard
 * lines only), and the allocation is that same total, never above the bill's outstanding amount in Xero (net payable less credits already against it).
 */
function assertAgrees(opts: { netPayable: number; credit: number; standardNet: number; standardRate: number; xeroNet: number; others?: number }) {
  const q = queued()
  assert.equal(q.lineAmountsIncludeTax, false, 'posts exclusive, as the bill does')
  const nets = q.lines.reduce((a, l) => a + l.unitAmount, 0)
  assert.equal(round2(nets), opts.xeroNet, 'the Xero credit lines carry the credit net')
  const stdVat = round2(opts.standardNet * opts.standardRate)
  const total = round2(nets + stdVat)
  assert.equal(total, opts.credit, 'the Xero credit total is the credit amount')
  assert.equal(q.allocateAmount, total, 'the allocation is the Xero credit total')
  assert.ok(q.allocateAmount! <= round2(opts.netPayable - (opts.others ?? 0)) + 1e-9, 'the allocation does not exceed what is outstanding on the Xero bill')
  assert.equal(transit.length, 1)
  assert.equal(transit[0]!.sourceType, 'SUPPLIER_CREDIT_NOTE')
  assert.equal(round2(-transit[0]!.baseDelta), round2(nets), 'the transit movement is the credit net')
  assert.equal(round2(total), round2(-transit[0]!.baseDelta + stdVat), 'journal balances: Dr payables = Cr transit + Cr VAT')
}

for (const [label, amount] of [['a FULL credit', '100'], ['a PARTIAL credit', '30']] as const) {
  test(`${label} against a reverse-charge bill (net 100 at 20%, IMS total 120): the net is credited, allocated and moved through transit`, async () => {
    reset()
    CREDIT_NOTE = baseCredit(amount, [rcLine], '20', 'xero-bill-1')
    const result = await post()
    assert.equal(result.success, true, JSON.stringify(result))
    assert.equal(committed.posted, 1)
    assert.deepEqual(committed.syncRows, [{ connector: 'xero', type: 'PURCHASE_CREDIT_NOTE' }])
    const q = queued()
    assert.equal(q.lines.length, 1)
    assert.deepEqual([q.lines[0]!.unitAmount, q.lines[0]!.taxType, q.lines[0]!.accountCode, q.lines[0]!.taxRateId], [Number(amount), 'REVERSECHARGES', 'X-TRANSIT', 'r-rc'])
    assert.equal(q.allocateToInvoiceId, 'xero-bill-1')
    assertAgrees({ netPayable: 100, credit: Number(amount), standardNet: 0, standardRate: 0, xeroNet: Number(amount) })
  })
}

test('a credit of the IMS bill TOTAL (120) against a reverse-charge bill is refused: it exceeds the net payable (100); nothing is claimed or queued', async () => {
  reset()
  CREDIT_NOTE = baseCredit('120', [rcLine], '20', 'xero-bill-1')
  const result = await post()
  assert.equal(result.success, false)
  assert.match(String(result.error), /limited to what is owed to the supplier \(100\.00, excluding the VAT the bill accounts for itself\); 100\.00 is still creditable/)
  assert.equal(committed.posted, 0)
  assert.equal(committed.syncRows.length, 0)
  assert.equal(transit.length, 0)
})

test('credits already against the bill count against the net payable: 80 recorded + 30 more is refused, 80 + 20 is allowed', async () => {
  reset()
  otherCredits = '80'
  CREDIT_NOTE = baseCredit('30', [rcLine], '20', 'xero-bill-1')
  const refused = await post()
  assert.equal(refused.success, false)
  assert.match(String(refused.error), /20\.00 is still creditable/)
  assert.equal(committed.posted, 0)

  reset()
  otherCredits = '80'
  CREDIT_NOTE = baseCredit('20', [rcLine], '20', 'xero-bill-1')
  const ok = await post()
  assert.equal(ok.success, true, JSON.stringify(ok))
  assertAgrees({ netPayable: 100, credit: 20, standardNet: 0, standardRate: 0, xeroNet: 20, others: 80 })
})

// MIXED BILL: reverse-charge net 100 (owed 100) + standard net 50 at 20% (owed 60): IMS total 180, net payable 160.
for (const [label, amount, rcNet, stdNet, xeroNet] of [['a FULL credit', '160', 100, 50, 150], ['a PARTIAL credit', '80', 50, 25, 75]] as const) {
  test(`${label} against a MIXED bill (reverse-charge plus standard lines): each line on its own code, exclusive, net payable 160`, async () => {
    reset()
    CREDIT_NOTE = baseCredit(amount, [rcLine, stdLine], '30', 'xero-bill-1')
    const result = await post()
    assert.equal(result.success, true, JSON.stringify(result))
    assert.equal(committed.posted, 1)
    const q = queued()
    assert.deepEqual(q.lines.map((l) => [l.unitAmount, l.taxType, l.taxRateId]), [[rcNet, 'REVERSECHARGES', 'r-rc'], [stdNet, 'INPUT2', 'r-std']])
    assertAgrees({ netPayable: 160, credit: Number(amount), standardNet: stdNet, standardRate: 0.2, xeroNet })
  })
}

test('a mixed bill refuses a credit above its net payable (160), not its IMS total (180)', async () => {
  reset()
  CREDIT_NOTE = baseCredit('170', [rcLine, stdLine], '30', 'xero-bill-1')
  const result = await post()
  assert.equal(result.success, false)
  assert.match(String(result.error), /\(160\.00, excluding the VAT/)
  assert.equal(committed.posted, 0)
})

test('a foreign-currency reverse-charge credit moves its net through transit in the BASE currency (divided by the rate)', async () => {
  reset()
  CREDIT_NOTE = { ...baseCredit('100', [rcLine], '20', 'xero-bill-1'), currency: 'EUR', fxRateToBase: new Prisma.Decimal('2') }
  const result = await post()
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(transit[0]!.baseDelta, -50)
  assert.equal(queued().lines[0]!.unitAmount, 100, 'the Xero line stays in the document currency')
})

test('a bill with a non-reverse-charge mix (taxable plus exempt) is still refused as mixed', async () => {
  reset()
  CREDIT_NOTE = baseCredit('30', [snapshot({}), snapshot({ taxType: 'NONE', taxRateValue: new Prisma.Decimal('0'), taxRateId: null })], '20')
  const result = await post()
  assert.equal(result.success, false)
  assert.match(String(result.error), /mixes VAT treatments/)
  assert.equal(committed.posted, 0)
})

test('CONTROL: a credit against a NON-reverse-charge bill is unchanged (one gross inclusive line, allocation = the amount, transit = the net by the VAT ratio)', async () => {
  reset()
  CREDIT_NOTE = baseCredit('120', [snapshot({})], '20', 'xero-bill-1')
  const result = await post()
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(committed.posted, 1)
  assert.deepEqual(committed.syncRows, [{ connector: 'xero', type: 'PURCHASE_CREDIT_NOTE' }])
  const q = queued()
  assert.equal(q.lines.length, 1)
  assert.deepEqual([q.lines[0]!.unitAmount, q.lines[0]!.taxType, q.lineAmountsIncludeTax, q.allocateAmount], [120, 'INPUT2', true, 120])
  assert.equal(round2(-transit[0]!.baseDelta), 100)
})

test('CONTROL: a LOCAL-ONLY credit (Xero sync off, nothing goes to Xero) against a reverse-charge bill posts without Xero figures', async () => {
  reset()
  xeroSync = 'false'
  CREDIT_NOTE = baseCredit('30', [rcLine], '0')
  const result = await post()
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(committed.syncRows.length, 0, 'nothing goes to Xero')
})

test('a LEGACY bill line that reconstructs the right VAT but has NO mapped tax type: the credit stays DRAFT, nothing is claimed or queued, and the refusal is returned', async () => {
  reset()
  const legacyLine = { poLineId: 'pl1', costLineId: null, totalForeign: new Prisma.Decimal('100'), taxBookedAt: null, taxType: null, taxRateValue: null, taxRateId: null, taxReverseCharge: null }
  const credit = baseCredit('30', [legacyLine], '20') as Record<string, unknown> & { po: Record<string, unknown> }
  // The order line is priced at 20% (tax 20 on net 100), so the legacy reconstruction reproduces the bill's VAT; its rate has no mapped accounting tax type.
  credit.po = { ...credit.po, lines: [{ id: 'pl1', taxForeign: new Prisma.Decimal('20'), totalForeign: new Prisma.Decimal('100'), taxRate: { id: 'r-unmapped', accountingTaxType: null, reverseCharge: false, rate: new Prisma.Decimal('0.2'), isCompound: false, components: [] } }] }
  CREDIT_NOTE = credit
  const result = await post()
  assert.equal(result.success, false)
  assert.match(String(result.error), /^NOTHING WAS SENT\. Supplier credit note CN-1 was refused: no tax type on line 1/)
  assert.equal(committed.posted, 0, 'the credit note was NOT claimed DRAFT->POSTED')
  assert.equal(committed.syncRows.length, 0, 'nothing was queued')
})

test('CONTROL: the payload that is queued is the one that was validated (the booked code, never a substitute)', async () => {
  reset()
  CREDIT_NOTE = baseCredit('120', [snapshot({})])
  const result = await post()
  assert.equal(result.success, true, JSON.stringify(result))
  const line = (committed.payloads[0]!.lines as Array<Record<string, unknown>>)[0]!
  assert.deepEqual([line.taxType, line.taxRateId, line.taxRateBasis], ['INPUT2', 'r-std', 'plain'])
})

test('a Xero-bound credit against a bill booked on an INACTIVE rate is refused before anything is claimed; a local-only credit is not', async () => {
  reset()
  CREDIT_NOTE = baseCredit('120', [snapshot({ taxRateId: 'r-old' })])
  inactiveRateRows = [{ id: 'r-old', name: 'Old 20' }]
  const refused = await post()
  assert.equal(refused.success, false)
  assert.match(String(refused.error), /priced on a VAT rate that is inactive \("Old 20"\)/)
  assert.equal(committed.posted, 0)
  assert.equal(committed.syncRows.length, 0)

  reset()
  xeroSync = 'false'
  CREDIT_NOTE = baseCredit('120', [snapshot({ taxRateId: 'r-old' })])
  inactiveRateRows = [{ id: 'r-old', name: 'Old 20' }]
  const local = await post()
  assert.doesNotMatch(String(local.error ?? ''), /inactive/)
})

test('a LEGACY bill whose reconstruction no longer reproduces the recorded VAT is refused before anything is claimed', async () => {
  reset()
  // Booked at 20% (VAT 20 on 100), but the order line\'s rate now says 5%: today\'s rate does not reproduce the bill.
  const legacy = { poLineId: 'pl1', costLineId: null, totalForeign: new Prisma.Decimal('100'), taxBookedAt: null, taxType: null, taxRateValue: null, taxRateId: null, taxReverseCharge: null }
  const credit = baseCredit('30', [legacy], '20') as Record<string, unknown> & { po: Record<string, unknown> }
  credit.po = { ...credit.po, lines: [{ id: 'pl1', taxForeign: new Prisma.Decimal('20'), totalForeign: new Prisma.Decimal('100'), taxRate: { id: 'r-now', accountingTaxType: 'INPUT5', reverseCharge: false, rate: new Prisma.Decimal('0.05'), isCompound: false, components: [] } }] }
  CREDIT_NOTE = credit
  const result = await post()
  assert.equal(result.success, false)
  assert.match(String(result.error), /booked before its tax treatment was recorded/)
  assert.equal(committed.posted, 0)
  assert.equal(committed.syncRows.length, 0)
})

test('a credit whose BOOKED code now charges another rate in the ledger is refused before anything is claimed', async () => {
  reset()
  CREDIT_NOTE = baseCredit('120', [snapshot({ taxRateValue: new Prisma.Decimal('0.05') })], '5')
  ledgerTenant = 'tenant-1'
  ledgerRates = [{ taxType: 'INPUT2', effectiveRate: 20 }]
  const result = await post()
  assert.equal(result.success, false)
  assert.match(String(result.error), /The credit note was not posted \(it is still a draft\).*taxed at 5% in IMS but posts on INPUT2, which charges 20%/)
  assert.equal(committed.posted, 0)
  assert.equal(committed.syncRows.length, 0)
})

test('a LOCAL-ONLY credit with an undecided tax type is not refused for it (nothing goes to Xero)', async () => {
  reset()
  xeroSync = 'false'
  const legacy = { poLineId: 'pl1', costLineId: null, totalForeign: new Prisma.Decimal('100'), taxBookedAt: null, taxType: null, taxRateValue: null, taxRateId: null, taxReverseCharge: null }
  const credit = baseCredit('30', [legacy], '20') as Record<string, unknown> & { po: Record<string, unknown> }
  credit.po = { ...credit.po, lines: [{ id: 'pl1', taxForeign: new Prisma.Decimal('20'), totalForeign: new Prisma.Decimal('100'), taxRate: { id: 'r-unmapped', accountingTaxType: null, reverseCharge: false, rate: new Prisma.Decimal('0.2'), isCompound: false, components: [] } }] }
  CREDIT_NOTE = credit
  const result = await post()
  assert.doesNotMatch(String(result.error ?? ''), /no tax type on line/)
})
