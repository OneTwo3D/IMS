import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkRatesAgainstXero, describeRefusals, planPurchaseTaxImport, PurchaseTaxImportRaceError, readStoredXeroList, writePurchaseTaxImport,
  type PurchaseTaxImportPlan,
} from '@/lib/tax/purchase-tax-import'
import { digestTaxRateList, type NormalisedXeroTaxRate } from '@/lib/connectors/xero/tax-rate-list'
import { DRIFT_MAX_STALENESS_MS } from '@/lib/domain/accounting/tax-rate-drift-status'

/**
 * THE IMPORT OF IMS TAX RATES FROM THE STORED XERO LIST, over an in-memory client (the planner and the list reader are pure over the client; the committed behaviour is in
 * tests/concurrency/purchase-tax-import.concurrent.test.ts). Each guard has a `[mutation: ...]` line: the change that turns its arm red (made, seen red, reverted).
 */

const TENANT = 'tenant-1'
const NOW = new Date('2026-10-25T12:00:00Z')
const FETCHED = new Date('2026-10-25T11:30:00Z')

const xeroRow = (taxType: string, over: Partial<NormalisedXeroTaxRate> & { expenses?: boolean | null; revenue?: boolean | null } = {}): NormalisedXeroTaxRate => {
  const { expenses = true, revenue = false, ...rest } = over
  return {
    taxType, name: `Xero ${taxType}`, status: 'ACTIVE', reportTaxType: null, effectiveRate: '20.000000', displayTaxRate: '20.000000',
    components: [{ name: 'VAT', rate: '20.000000', compound: false, nonRecoverable: false }],
    canApply: { assets: false, equity: false, expenses, liabilities: false, revenue },
    ...rest,
  }
}
const XERO_LIST = [
  xeroRow('INPUT2', { name: '20% (VAT on Expenses)' }),
  xeroRow('ZERORATEDINPUT', { name: 'Zero Rated Expenses', effectiveRate: '0.000000', displayTaxRate: '0.000000', components: [{ name: 'Zero', rate: '0.000000', compound: false, nonRecoverable: false }] }),
  xeroRow('NONE', { name: 'No VAT', effectiveRate: '0.000000', displayTaxRate: '0.000000', components: [] }),
  xeroRow('OUTPUT2', { name: '20% (VAT on Income)', expenses: false, revenue: true }),
  xeroRow('ZERORATEDOUTPUT', { name: 'Zero Rated Income', effectiveRate: '0.000000', displayTaxRate: '0.000000', components: [{ name: 'Zero', rate: '0.000000', compound: false, nonRecoverable: false }], expenses: false, revenue: true }),
]

type ImsRow = { countryCode?: string | null; id: string; name: string; rate: string; usedFor: string; active: boolean; accountingTaxType: string | null; isDefault: boolean; refs?: number; /** non-cancelled sales order lines on it */ live?: number; /** non-cancelled purchase order lines on it */ livePo?: number; /** non-cancelled sales orders naming it */ named?: number }
type SupplierRow = { id: string; taxRateId: string | null }
type Mapping = { id: string; taxRateId: string; storeIdentity: string | null }
type State = { suppliers?: SupplierRow[]; mappings?: Mapping[]; rates: ImsRow[]; list: NormalisedXeroTaxRate[] | null; tenant?: string; fetchedAt?: Date; stamp?: string | null; headerDigest?: string; settings?: Record<string, string>; rowCount?: number }

const decimal = (s: string) => ({ toFixed: (dp?: number) => (dp === undefined ? s : Number(s).toFixed(dp)) })

/** A client answering only the reads the planner and the reader make, from `state`. */
function client(state: State) {
  const list = state.list
  const tenant = state.tenant ?? TENANT
  const fetchedAt = state.fetchedAt ?? FETCHED
  return {
    xeroTaxRateList: {
      findMany: async () => list === null ? [] : [{ connector: 'xero', tenantId: tenant, fetchedAt, rowCount: state.rowCount ?? list.length, digest: state.headerDigest ?? digestTaxRateList(tenant, list) }],
    },
    xeroTaxRate: {
      findMany: async () => (list ?? []).map((r) => ({
        connector: 'xero', tenantId: tenant, taxType: r.taxType, name: r.name, status: r.status, reportTaxType: r.reportTaxType,
        effectiveRate: r.effectiveRate === null ? null : decimal(r.effectiveRate), displayTaxRate: r.displayTaxRate === null ? null : decimal(r.displayTaxRate),
        components: r.components, canApplyToAssets: r.canApply.assets, canApplyToEquity: r.canApply.equity, canApplyToExpenses: r.canApply.expenses,
        canApplyToLiabilities: r.canApply.liabilities, canApplyToRevenue: r.canApply.revenue,
      })),
    },
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        if (where.key === 'xero_tax_rate_drift_last_checked_at') {
          const stamp = state.stamp === undefined ? fetchedAt.toISOString() : state.stamp
          return stamp === null ? null : { value: stamp }
        }
        const v = state.settings?.[where.key]
        return v === undefined ? null : { value: v }
      },
    },
    salesOrderLine: { count: async ({ where }: { where: { taxRateId: string } }) => state.rates.find((r) => r.id === where.taxRateId)?.live ?? 0 },
    purchaseOrderLine: { count: async ({ where }: { where: { taxRateId: string } }) => state.rates.find((r) => r.id === where.taxRateId)?.livePo ?? 0 },
    salesOrder: { count: async ({ where }: { where: { taxRateName: string } }) => state.rates.filter((r) => r.name === where.taxRateName).reduce((n, r) => n + (r.named ?? 0), 0) },
    taxRate: {
      findMany: async () => state.rates.map((r) => ({
        id: r.id, name: r.name, rate: decimal(r.rate), usedFor: r.usedFor, active: r.active, accountingTaxType: r.accountingTaxType, isDefault: r.isDefault, countryCode: r.countryCode ?? null, components: [],
        _count: { supplierTaxRate: r.refs ?? 0, poLines: r.refs ?? 0, orderLines: 0, shoppingTaxRateMappings: 0 },
      })),
    },
  } as never
}

const ims = (id: string, name: string, usedFor: string, type: string | null, over: Partial<ImsRow> = {}): ImsRow => ({ id, name, rate: '0.2000', usedFor, active: true, accountingTaxType: type, isDefault: false, ...over })
/** The shape of stage the owner described: BOTH-use rates with sales-side types, Demo leftovers, no INPUT2 / ZERORATEDINPUT, no NONE. */
const stageRates = (): ImsRow[] => [
  ims('uk', 'UK VAT', 'BOTH', 'OUTPUT2', { isDefault: true, refs: 4 }),
  ims('zr', 'Zero Rated', 'BOTH', 'ZERORATEDOUTPUT', { rate: '0.0000', refs: 2 }),
  ims('demo1', 'Demo Austria', 'BOTH', 'TAX001', { refs: 1 }),
  ims('demo2', 'Demo Belgium', 'BOTH', 'TAX002'),
]
const plan = (state: State, options: Partial<Parameters<typeof planPurchaseTaxImport>[1]> = {}) =>
  planPurchaseTaxImport(client(state), { now: NOW, connectedTenantId: TENANT, ...options })
const codes = (p: PurchaseTaxImportPlan) => p.refusals.map((r) => `${r.code}${r.taxType ? `:${r.taxType}` : ''}`).sort()

/** Apply a plan to the in-memory state the way writePurchaseTaxImport would (through a recording tx), so a re-run can be planned. */
async function applyTo(state: State, p: PurchaseTaxImportPlan): Promise<{ calls: Array<{ op: string; data?: Record<string, unknown>; where?: Record<string, unknown> }> }> {
  const calls: Array<{ op: string; data?: Record<string, unknown>; where?: Record<string, unknown> }> = []
  const tx = {
    ...(client(state) as object),
    $executeRaw: async () => { calls.push({ op: 'lock' }); return 0 },
    supplier: {
      updateMany: async ({ where, data }: { where: { taxRateId: string }; data: { taxRateId: string } }) => {
        calls.push({ op: 'supplier.updateMany', where, data })
        const hit = (state.suppliers ?? []).filter((x) => x.taxRateId === where.taxRateId)
        for (const x of hit) x.taxRateId = data.taxRateId
        return { count: hit.length }
      },
    },
    shoppingTaxRateMapping: {
      updateMany: async ({ where, data }: { where: { taxRateId: string }; data: { taxRateId: string; storeIdentity: null } }) => {
        calls.push({ op: 'mapping.updateMany', where, data })
        const hit = (state.mappings ?? []).filter((x) => x.taxRateId === where.taxRateId)
        for (const x of hit) { x.taxRateId = data.taxRateId; x.storeIdentity = data.storeIdentity }
        return { count: hit.length }
      },
    },
    taxRate: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const r = state.rates.find((x) => x.id === where.id)
        return r === undefined ? null : { name: r.name, rate: decimal(r.rate), usedFor: r.usedFor, active: r.active, components: [] }
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push({ op: 'create', data })
        const id = `new-${state.rates.length}`
        state.rates.push(ims(id, data.name as string, data.usedFor as string, data.accountingTaxType as string, { rate: data.rate as string }))
        return { id }
      },
      updateMany: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.push({ op: 'updateMany', where, data })
        const row = state.rates.find((r) => r.id === where.id)!
        if ((where as { isDefault?: boolean }).isDefault === false && row.isDefault) return { count: 0 }
        if ('usedFor' in data) row.usedFor = data.usedFor as string
        if ('active' in data) row.active = data.active as boolean
        return { count: 1 }
      },
    },
  }
  await writePurchaseTaxImport(tx as never, p)
  return { calls }
}

// ---------------------------------------------------------------------------------------------------------------------------------

// [mutation: the create loop of writePurchaseTaxImport removed -> red]
test('the import creates INPUT2, ZERORATEDINPUT and NONE as active PURCHASE rates from the stored list, with Xero\'s name, rate, components and tax type', async () => {
  const state: State = { rates: stageRates(), list: XERO_LIST }
  const p = await plan(state)
  assert.deepEqual(p.refusals, [])
  assert.deepEqual(p.creates.map((c) => [c.taxType, c.name, c.rate, c.type, c.taxCategory, c.isCompound]).sort(), [
    ['INPUT2', '20% (VAT on Expenses)', '0.2000', 'VAT', 'STANDARD', false],
    ['NONE', 'No VAT', '0.0000', 'NONE', 'ZERO', false],
    ['ZERORATEDINPUT', 'Zero Rated Expenses', '0.0000', 'VAT', 'ZERO', false],
  ])
  assert.deepEqual(p.creates.find((c) => c.taxType === 'INPUT2')!.components, [{ name: 'VAT', rate: '0.2000', compoundOnPrevious: false, sortOrder: 0 }])
  assert.deepEqual(p.creates.find((c) => c.taxType === 'NONE')!.components, [])
  const { calls } = await applyTo(state, p)
  const created = calls.filter((c) => c.op === 'create').map((c) => c.data!)
  assert.equal(created.length, 3)
  for (const data of created) {
    assert.equal(data.usedFor, 'PURCHASE')
    assert.equal(data.active, true)
    assert.equal(data.reverseCharge, false)
    assert.equal(data.countryCode, null)
  }
})

// [mutation: the TYPE_NOT_IN_XERO / TYPE_NOT_ACTIVE_IN_XERO branches deleted -> a missing or inactive type is "created" from nothing]
test('a type missing from Xero, or not ACTIVE there, is refused by name and gets no row; the others are still planned', async () => {
  const list = XERO_LIST.filter((r) => r.taxType !== 'ZERORATEDINPUT').map((r) => (r.taxType === 'NONE' ? { ...r, status: 'ARCHIVED' as const } : r))
  const p = await plan({ rates: stageRates(), list })
  assert.deepEqual(codes(p), ['TYPE_NOT_ACTIVE_IN_XERO:NONE', 'TYPE_NOT_IN_XERO:ZERORATEDINPUT'])
  assert.deepEqual(p.creates.map((c) => c.taxType), ['INPUT2'])
})

// [mutation: the `canApply.expenses !== true` test weakened to `=== false` -> the unknown (null) arm goes red; removed -> all go red]
test('a type Xero does not allow on expenses (false, or not stated) is refused: no row', async () => {
  for (const expenses of [false, null]) {
    const list = XERO_LIST.map((r) => (r.taxType === 'INPUT2' ? { ...r, canApply: { ...r.canApply, expenses } } : r))
    const p = await plan({ rates: stageRates(), list })
    assert.deepEqual(codes(p), ['TYPE_NOT_USABLE_ON_EXPENSES:INPUT2'], `expenses=${expenses}`)
    assert.equal(p.creates.some((c) => c.taxType === 'INPUT2'), false)
  }
})

// [mutation: the rate taken as `new Dec(stated)` without the /100 -> red; the decimalPlaces() <= 4 test removed -> the 20.125 arm goes red]
test('the rate is Xero\'s, converted exactly: a percent that Decimal(5,4) cannot hold as a fraction, or no stated rate, is refused (never rounded or invented)', async () => {
  const odd = XERO_LIST.map((r) => (r.taxType === 'INPUT2' ? { ...r, effectiveRate: '20.125000', components: [{ name: 'VAT', rate: '20.125000', compound: false, nonRecoverable: false }] } : r))
  assert.deepEqual(codes(await plan({ rates: stageRates(), list: odd })), ['RATE_NOT_REPRESENTABLE:INPUT2'])
  const unstated = XERO_LIST.map((r) => (r.taxType === 'INPUT2' ? { ...r, effectiveRate: null, displayTaxRate: null } : r))
  assert.deepEqual(codes(await plan({ rates: stageRates(), list: unstated })), ['RATE_NOT_STATED:INPUT2'])
  const fallback = XERO_LIST.map((r) => (r.taxType === 'INPUT2' ? { ...r, effectiveRate: null, displayTaxRate: '20.000000' } : r))
  assert.equal((await plan({ rates: stageRates(), list: fallback })).creates.find((c) => c.taxType === 'INPUT2')!.rate, '0.2000', 'the display rate stands in for a missing effective rate')
  const disagree = XERO_LIST.map((r) => (r.taxType === 'INPUT2' ? { ...r, components: [{ name: 'VAT', rate: '15.000000', compound: false, nonRecoverable: false }] } : r))
  assert.deepEqual(codes(await plan({ rates: stageRates(), list: disagree })), ['RATE_INCONSISTENT:INPUT2'])
  const nonRec = XERO_LIST.map((r) => (r.taxType === 'INPUT2' ? { ...r, components: [{ name: 'VAT', rate: '20.000000', compound: false, nonRecoverable: true }] } : r))
  assert.deepEqual(codes(await plan({ rates: stageRates(), list: nonRec })), ['NON_RECOVERABLE_COMPONENT:INPUT2'])
})

// [mutation: the `mine.length === 1` present-branch removed -> the second plan creates again]
test('a re-run is a no-op: after the write the plan has nothing to create, narrow or deactivate (and the present rates are reported)', async () => {
  const state: State = { rates: stageRates(), list: XERO_LIST }
  const options = { narrowSalesTypes: true, deactivateAbsent: true }
  const first = await plan(state, options)
  assert.equal(first.creates.length, 3)
  assert.ok(first.narrow.length > 0 && first.notInXero.some((r) => r.deactivate))
  await applyTo(state, first)
  const second = await plan(state, options)
  assert.deepEqual([second.creates.length, second.narrow.length, second.notInXero.filter((r) => r.deactivate).length, second.refusals.length], [0, 0, 0, 0])
  assert.deepEqual(second.present.map((r) => r.taxType).sort(), ['INPUT2', 'NONE', 'ZERORATEDINPUT'])
})

// [mutation: the write also sets rate or accounting_tax_type on narrow/deactivate -> red]
test('a referenced row\'s rate and type are never changed: the only writes to existing rows are usedFor (narrow) and active (deactivate), by id, and no row is deleted', async () => {
  const state: State = { rates: stageRates(), list: XERO_LIST }
  const before = JSON.stringify(state.rates.map((r) => [r.id, r.rate, r.accountingTaxType, r.name]))
  const p = await plan(state, { narrowSalesTypes: true, deactivateAbsent: true })
  const { calls } = await applyTo(state, p)
  assert.ok(calls.some((c) => c.op === 'updateMany'), 'control: existing rows were touched')
  for (const call of calls.filter((c) => c.op === 'updateMany')) assert.ok(Object.keys(call.data!).every((k) => k === 'usedFor' || k === 'active'), JSON.stringify(call.data))
  assert.equal(calls.some((c) => c.op === 'delete' || c.op === 'deleteMany'), false)
  const after = JSON.stringify(state.rates.filter((r) => !r.id.startsWith('new-')).map((r) => [r.id, r.rate, r.accountingTaxType, r.name]))
  assert.equal(after, before)
})

// [mutation: the `options.narrowSalesTypes` guard removed -> the default plan narrows; the NARROW_REQUIRES_PURCHASE_ROWS guard removed -> the blocked arm narrows]
test('BOTH rows with a sales-only Xero type are narrowed to SALES only through the explicit option, and only when every purchase type is satisfied', async () => {
  const state: State = { rates: stageRates(), list: XERO_LIST }
  const byDefault = await plan(state)
  assert.deepEqual(byDefault.narrow, [], 'default: report-only, nothing narrowed')
  const narrowed = await plan(state, { narrowSalesTypes: true })
  assert.deepEqual(narrowed.narrow.map((n) => [n.id, n.taxType, n.references.suppliers]), [['uk', 'OUTPUT2', 4], ['zr', 'ZERORATEDOUTPUT', 2]])
  await applyTo(state, narrowed)
  assert.deepEqual(state.rates.filter((r) => ['uk', 'zr'].includes(r.id)).map((r) => r.usedFor), ['SALES', 'SALES'])
  assert.equal(state.rates.find((r) => r.id === 'demo1')!.usedFor, 'BOTH', 'a type Xero does not list is not a sales-only type')
  // Blocked: INPUT2 not usable on expenses -> nothing is narrowed.
  const blocked = await plan({ rates: stageRates(), list: XERO_LIST.map((r) => (r.taxType === 'INPUT2' ? { ...r, canApply: { ...r.canApply, expenses: false } } : r)) }, { narrowSalesTypes: true })
  assert.deepEqual(blocked.narrow, [])
  assert.ok(codes(blocked).includes('NARROW_REQUIRES_PURCHASE_ROWS'))
  // A type that Xero allows on BOTH revenue and expenses is not sales-only.
  const both = await plan({ rates: [...stageRates(), ims('x', 'Both ways', 'BOTH', 'BOTHWAYS')], list: [...XERO_LIST, xeroRow('BOTHWAYS', { expenses: true, revenue: true })] }, { narrowSalesTypes: true })
  assert.equal(both.narrow.some((n) => n.id === 'x'), false)
})

// [mutation: `deactivate: options.deactivateAbsent === true && ...` replaced by `true` -> the default arm goes red; the isDefault guard removed -> the default-rate arm goes red]
test('rates whose type Xero does not list (Demo leftovers) are reported, deactivated only with the opt-in, and never the default rate', async () => {
  const state: State = { rates: [...stageRates(), ims('dflt', 'Demo default', 'BOTH', 'TAX099', { isDefault: true })], list: XERO_LIST }
  const reportOnly = await plan(state)
  assert.deepEqual(reportOnly.notInXero.map((r) => [r.id, r.reason, r.deactivate]), [['demo1', 'ABSENT_FROM_XERO', false], ['demo2', 'ABSENT_FROM_XERO', false], ['dflt', 'ABSENT_FROM_XERO', false]])
  assert.equal(reportOnly.notInXero.find((r) => r.id === 'demo1')!.references.suppliers, 1, 'the references are reported')
  const { calls } = await applyTo(state, reportOnly)
  assert.equal(calls.filter((c) => c.op === 'updateMany' && c.data && 'active' in c.data).length, 0, 'default: nothing deactivated')
  const opted = await plan(state, { deactivateAbsent: true })
  assert.deepEqual(opted.notInXero.map((r) => [r.id, r.deactivate, r.keptBecause]).sort(), [['demo1', true, null], ['demo2', true, null], ['dflt', false, 'IS_DEFAULT_RATE']])
  await applyTo(state, opted)
  assert.deepEqual(state.rates.filter((r) => r.id.startsWith('demo') || r.id === 'dflt').map((r) => [r.id, r.active]).sort(), [['demo1', false], ['demo2', false], ['dflt', true]])
  const archived = await plan({ rates: [ims('a', 'Archived type', 'BOTH', 'OLDRATE')], list: [...XERO_LIST, xeroRow('OLDRATE', { status: 'ARCHIVED' })] })
  assert.deepEqual(archived.notInXero.map((r) => r.reason), ['NOT_ACTIVE_IN_XERO'])
})

// [mutation: the AMBIGUOUS branch removed -> the plan creates a third INPUT2 rate]
test('a type that already has exactly one active purchase-capable rate is left alone, several are refused, and a name collision is refused', async () => {
  const one = await plan({ rates: [ims('a', 'Existing std', 'BOTH', 'INPUT2')], list: XERO_LIST })
  assert.deepEqual(one.creates.map((c) => c.taxType).sort(), ['NONE', 'ZERORATEDINPUT'])
  assert.deepEqual(one.present.map((r) => r.taxType), ['INPUT2'])
  const several = await plan({ rates: [ims('a', 'A', 'BOTH', 'INPUT2'), ims('b', 'B', 'PURCHASE', 'INPUT2')], list: XERO_LIST })
  assert.ok(codes(several).includes('AMBIGUOUS_EXISTING_RATES:INPUT2'))
  assert.equal(several.creates.some((c) => c.taxType === 'INPUT2'), false)
  const inactiveOnly = await plan({ rates: [ims('a', 'A', 'PURCHASE', 'INPUT2', { active: false }), ims('s', 'S', 'SALES', 'INPUT2')], list: XERO_LIST })
  assert.ok(inactiveOnly.creates.some((c) => c.taxType === 'INPUT2'), 'an inactive or sales-only rate is not a purchase rate: a new one is created')
  const collision = await plan({ rates: [ims('a', '  no vat ', 'SALES', null)], list: XERO_LIST })
  assert.ok(codes(collision).includes('NAME_COLLISION:NONE'))
})

// [mutation: the header / stamp / age / tenant / digest check removed -> its arm goes red]
test('a missing, unstamped, stale, foreign-organisation, tampered or unconnected stored list is refused by name and plans nothing', async () => {
  const base: State = { rates: stageRates(), list: XERO_LIST }
  const refusedWith = async (state: State, code: string, options: Partial<Parameters<typeof planPurchaseTaxImport>[1]> = {}) => {
    const p = await plan(state, options)
    assert.deepEqual(p.refusals.map((r) => r.code), [code], code)
    assert.deepEqual([p.creates.length, p.narrow.length, p.notInXero.length], [0, 0, 0], `${code}: plans nothing`)
  }
  assert.deepEqual((await plan(base)).refusals, [], 'control: the same list, intact, plans')
  await refusedWith({ ...base, list: null }, 'XERO_LIST_MISSING')
  await refusedWith({ ...base, stamp: null }, 'XERO_LIST_NOT_STAMPED')
  await refusedWith({ ...base, stamp: new Date(FETCHED.getTime() - 1000).toISOString() }, 'XERO_LIST_NOT_STAMPED')
  await refusedWith({ ...base, fetchedAt: new Date(NOW.getTime() - DRIFT_MAX_STALENESS_MS - 1000), stamp: undefined }, 'XERO_LIST_STALE')
  assert.deepEqual((await plan({ ...base, fetchedAt: new Date(NOW.getTime() - DRIFT_MAX_STALENESS_MS + 60_000), stamp: undefined })).refusals, [], 'just inside the limit passes')
  await refusedWith({ ...base, tenant: 'tenant-2' }, 'XERO_LIST_WRONG_ORGANISATION')
  await refusedWith(base, 'XERO_NOT_CONNECTED', { connectedTenantId: null })
  await refusedWith({ ...base, headerDigest: 'f'.repeat(64) }, 'XERO_LIST_UNREADABLE')
  await refusedWith({ ...base, rowCount: 99 }, 'XERO_LIST_UNREADABLE')
  await refusedWith({ ...base, fetchedAt: new Date(NOW.getTime() + 3_600_000), stamp: undefined }, 'XERO_LIST_UNREADABLE')
})

test('a type that already has its purchase rate needs no list; a refused list still reports it as present', async () => {
  const p = await plan({ rates: [ims('a', 'A', 'PURCHASE', 'INPUT2')], list: null })
  assert.deepEqual(codes(p), ['XERO_LIST_MISSING'])
  assert.deepEqual(p.present.map((r) => r.taxType), ['INPUT2'])
})

test('the reverse-charge purchase tax type the settings name is reported (no row is created for it), and an unvalidated list read does not leak values', async () => {
  const p = await plan({ rates: stageRates(), list: XERO_LIST, settings: { accounting_reverse_charge_purchase_tax_type: 'REVERSECHARGES' } })
  assert.equal(p.notes.length, 1)
  assert.match(p.notes[0]!, /REVERSECHARGES.*NOT in the stored Xero list/)
  assert.equal(p.creates.some((c) => c.taxType === 'REVERSECHARGES'), false)
  assert.equal((await readStoredXeroList(client({ rates: [], list: XERO_LIST }), NOW, TENANT)).ok, true)
  assert.equal(describeRefusals([{ code: 'XERO_LIST_STALE', taxType: null, detail: 'x' }, { code: 'TYPE_NOT_IN_XERO', taxType: 'NONE', detail: 'y' }]), 'XERO_LIST_STALE, TYPE_NOT_IN_XERO (NONE)')
})

test('an unlisted type name is not a tax type', async () => {
  const p = await plan({ rates: [], list: XERO_LIST }, { types: ['bad type!'] })
  assert.deepEqual(codes(p), ['TYPE_NOT_VALID:bad type!'])
})

// ---------------------------------------------------------------------------------------------------------------------------------
// One set of rates, Xero master: the sales side, differing percentages, the rate set and the rows no set can contain.

const REDUCED = xeroRow('OUTPUT5', { name: '5% (VAT on Income)', effectiveRate: '5.000000', displayTaxRate: '5.000000', components: [{ name: 'VAT', rate: '5.000000', compound: false, nonRecoverable: false }], expenses: false, revenue: true })

// [mutation: the `options.mirrorSales` gate removed -> the default plan creates sales rows; the SALES side mapped to usedFor PURCHASE in the write -> red]
test('sales mirroring creates the missing SALES rate for a revenue-only Xero type, under the same rules, and only when asked', async () => {
  const state: State = { rates: stageRates(), list: [...XERO_LIST, REDUCED, xeroRow('OLDOUT', { status: 'ARCHIVED', expenses: false, revenue: true })] }
  assert.deepEqual((await plan(state)).salesTypes, [], 'default: purchase side only')
  const p = await plan(state, { mirrorSales: true })
  assert.deepEqual(p.salesTypes, ['OUTPUT2', 'OUTPUT5', 'ZERORATEDOUTPUT'], 'an ARCHIVED type is not in scope')
  assert.deepEqual(p.creates.filter((c) => c.side === 'SALES').map((c) => [c.taxType, c.name, c.rate]), [['OUTPUT5', '5% (VAT on Income)', '0.0500']], 'OUTPUT2 / ZERORATEDOUTPUT already have their BOTH rows')
  const { calls } = await applyTo(state, p)
  assert.equal(calls.find((c) => c.op === 'create' && c.data!.accountingTaxType === 'OUTPUT5')!.data!.usedFor, 'SALES')
  const forced = await plan({ rates: [], list: XERO_LIST.map((r) => (r.taxType === 'ZERORATEDOUTPUT' ? { ...r, canApply: { ...r.canApply, revenue: null } } : r)) }, { mirrorSales: true, types: [] })
  assert.ok(codes(forced).includes('TYPE_NOT_USABLE_ON_REVENUE:ZERORATEDOUTPUT'), 'a default sales type that Xero does not allow on revenue is refused by name')
})

// [mutation: the percentage comparison removed -> nothing is reported; the replace branch edits the old row's rate instead of creating -> red]
test('a rate whose percentage differs from Xero is reported, and corrected only by a NEW row and a deactivated old one (opt-in), never by an edit', async () => {
  const state: State = { rates: [ims('old', 'Old UK VAT', 'BOTH', 'OUTPUT2', { rate: '0.1500', refs: 3 }), ims('in', 'Input old', 'PURCHASE', 'INPUT2', { rate: '0.1500' })], list: XERO_LIST }
  const reported = await plan(state, { mirrorSales: true })
  assert.deepEqual(reported.differs.map((d) => [d.taxType, d.side, d.imsRate, d.xeroRate, d.replaced, d.references.suppliers]).sort(), [['INPUT2', 'PURCHASE', '0.1500', '0.2000', false, 0], ['OUTPUT2', 'SALES', '0.1500', '0.2000', false, 3]])
  assert.equal(reported.creates.some((c) => c.taxType === 'OUTPUT2' || c.taxType === 'INPUT2'), false, 'default: reported only')
  assert.deepEqual(reported.rateSet.filter((e) => e.status === 'differs').map((e) => e.taxType).sort(), ['INPUT2', 'OUTPUT2'])
  const replaced = await plan(state, { mirrorSales: true, replaceDiffering: true })
  const before = JSON.stringify(state.rates.map((r) => [r.id, r.rate, r.accountingTaxType, r.name]))
  const { calls } = await applyTo(state, replaced)
  const newSales = calls.find((c) => c.op === 'create' && c.data!.accountingTaxType === 'OUTPUT2')!.data!
  assert.deepEqual([newSales.rate, newSales.usedFor, newSales.name], ['0.2000', 'SALES', '20% (VAT on Income)'])
  assert.deepEqual(state.rates.filter((r) => ['old', 'in'].includes(r.id)).map((r) => [r.rate, r.accountingTaxType, r.active]), [['0.1500', 'OUTPUT2', false], ['0.1500', 'INPUT2', false]], 'the old rows keep rate and type; they are only deactivated')
  assert.equal(JSON.stringify(state.rates.filter((r) => ['old', 'in'].includes(r.id)).map((r) => [r.id, r.rate, r.accountingTaxType, r.name])), JSON.stringify(JSON.parse(before)), 'no existing row was edited')
  assert.equal((await plan(state, { mirrorSales: true, replaceDiffering: true })).creates.length, 0, 're-run: nothing to do')
  // The default rate is never replaced.
  const dflt = await plan({ rates: [ims('d', 'Default VAT', 'BOTH', 'OUTPUT2', { rate: '0.1500', isDefault: true })], list: XERO_LIST }, { mirrorSales: true, replaceDiffering: true, types: [] })
  assert.deepEqual(dflt.differs.map((d) => [d.replaced, d.keptBecause]), [[false, 'IS_DEFAULT_RATE']])
})

// [mutation: the unmapped scan removed / rateSet entries dropped -> red]
test('the rate set lists every in-scope type with Xero\'s percentage and side; rows with no Xero type (per-country storefront rates) are reported as unmapped', async () => {
  const state: State = { rates: [...stageRates(), ims('se', 'Sweden 25%', 'SALES', null, { rate: '0.2500', countryCode: 'se' } as never)], list: [...XERO_LIST, REDUCED] }
  const p = await plan(state, { mirrorSales: true })
  const set = p.rateSet.map((e) => [e.taxType, e.side, e.percentage, e.status]).sort()
  assert.deepEqual(set, [
    ['INPUT2', 'PURCHASE', '20.000000', 'created'], ['NONE', 'PURCHASE', '0.000000', 'created'], ['OUTPUT2', 'SALES', '20.000000', 'present'], ['OUTPUT5', 'SALES', '5.000000', 'created'],
    ['ZERORATEDINPUT', 'PURCHASE', '0.000000', 'created'], ['ZERORATEDOUTPUT', 'SALES', '0.000000', 'present'],
  ])
  assert.deepEqual(p.unmapped.map((u) => [u.id, u.rate]), [['se', '0.2500']])
})

// [mutation: `fraction !== r.rate` dropped -> the column arm is red; `fraction !== r.effective` dropped -> the components arm is red; the NOT_IN_XERO / NOT_ACTIVE branches dropped -> their arms are red; the refusal return dropped -> the untrusted arms are red]
test('checkRatesAgainstXero holds the rate column AND the effective rate to Xero\'s stored row, and an untrusted list is a refusal, never a pass', async () => {
  const check = (state: State, rates: Array<{ taxType: string; rate: string; effective: string }>, tenant: string | null = TENANT) => checkRatesAgainstXero(client(state), NOW, tenant, rates)
  const state: State = { rates: [], list: XERO_LIST }
  const ok = await check(state, [{ taxType: 'INPUT2', rate: '0.2000', effective: '0.2000' }])
  assert.deepEqual(ok, { ok: true, disagreements: [] })
  const column = await check(state, [{ taxType: 'INPUT2', rate: '0.1500', effective: '0.2000' }])
  assert.ok(column.ok && column.disagreements.length === 1 && column.disagreements[0]!.reason === 'DIFFERS' && column.disagreements[0]!.xeroRate === '0.2000')
  const components = await check(state, [{ taxType: 'INPUT2', rate: '0.2000', effective: '0.1500' }])
  assert.ok(components.ok && components.disagreements.length === 1, 'the column agrees, the components do not')
  const absent = await check(state, [{ taxType: 'NOPE', rate: '0.2000', effective: '0.2000' }])
  assert.ok(absent.ok && absent.disagreements[0]!.reason === 'NOT_IN_XERO')
  const archived = await check({ rates: [], list: XERO_LIST.map((r) => (r.taxType === 'INPUT2' ? { ...r, status: 'ARCHIVED' as const } : r)) }, [{ taxType: 'INPUT2', rate: '0.2000', effective: '0.2000' }])
  assert.ok(archived.ok && archived.disagreements[0]!.reason === 'NOT_ACTIVE_IN_XERO')
  for (const [label, bad, tenant] of [
    ['stale', { rates: [], list: XERO_LIST, fetchedAt: new Date(NOW.getTime() - DRIFT_MAX_STALENESS_MS - 1000), stamp: undefined } as State, TENANT],
    ['missing', { rates: [], list: null } as State, TENANT],
    ['not connected', state, null],
  ] as const) {
    const r = await check(bad, [{ taxType: 'INPUT2', rate: '0.2000', effective: '0.2000' }], tenant)
    assert.equal(r.ok, false, label)
  }
})

// ---------------------------------------------------------------------------------------------------------------------------------
// Live documents, supplier defaults and dual-side types.

const activeOf = (state: State, id: string): boolean => state.rates.find((r) => r.id === id)!.active

// [mutation: the live-document count removed from the deactivation guard -> every arm is red; each of its three terms (sales lines, purchase lines, orders naming the rate) dropped -> its arm is red;
//  the re-count at the write removed -> the race arm is red; the lock-and-recheck skipped for a deactivation -> the race arm is red]
test('deactivateAbsent keeps a rate that a live document still resolves its tax identity through (sales lines, purchase lines, or an order naming it), reports why, and deactivates the rest', async () => {
  const rates = (): ImsRow[] => [
    ims('uk', 'UK VAT', 'BOTH', 'OUTPUT2', { isDefault: true }),
    ims('free', 'Demo free', 'BOTH', 'TAX001'),
    ims('lines', 'Demo sales lines', 'BOTH', 'TAX002', { live: 2 }),
    ims('po', 'Demo purchase lines', 'BOTH', 'TAX003', { livePo: 1 }),
    ims('named', 'Demo named', 'BOTH', 'TAX004', { named: 3 }),
  ]
  const state: State = { rates: rates(), list: XERO_LIST }
  const p = await plan(state, { deactivateAbsent: true })
  assert.deepEqual(p.notInXero.map((r) => [r.id, r.deactivate, r.keptBecause, r.liveDocuments]), [
    ['free', true, null, 0], ['lines', false, 'LIVE_DOCUMENTS', 2], ['po', false, 'LIVE_DOCUMENTS', 1], ['named', false, 'LIVE_DOCUMENTS', 3],
  ])
  await applyTo(state, p)
  assert.deepEqual(state.rates.filter((r) => !r.id.startsWith('new-')).map((r) => [r.id, r.active]), [['uk', true], ['free', false], ['lines', true], ['po', true], ['named', true]], 'only the free rate is deactivated')
  // Without the opt-in nothing is checked and nothing deactivated.
  assert.deepEqual((await plan({ rates: rates(), list: XERO_LIST })).notInXero.map((r) => [r.id, r.deactivate, r.liveDocuments]), [['free', false, null], ['lines', false, null], ['po', false, null], ['named', false, null]])
  // A document that appears between the plan and the write stops the write: the row is not deactivated.
  const racing: State = { rates: rates(), list: XERO_LIST }
  const planned = await plan(racing, { deactivateAbsent: true })
  racing.rates.find((r) => r.id === 'free')!.live = 1
  await assert.rejects(() => applyTo(racing, planned), PurchaseTaxImportRaceError)
  assert.equal(activeOf(racing, 'free'), true)
})

// [mutation: the supplier re-point removed -> the supplier arm is red; the mapping re-point removed -> the mapping arm is red; the re-point runs for a row that was not deactivated -> the default arm is red;
//  the live-document check removed from the replace branch -> the blocked arm is red; the re-check at the write removed -> the race arm is red]
test('replaceDiffering moves the supplier defaults and storefront mappings of the old rate to the new one in the same write, and does not replace a rate that live documents depend on', async () => {
  const state: State = {
    rates: [ims('old', 'Old UK VAT', 'BOTH', 'OUTPUT2', { rate: '0.1500' }), ims('busy', 'Old input', 'PURCHASE', 'INPUT2', { rate: '0.1500', live: 1 })],
    list: XERO_LIST,
    suppliers: [{ id: 's1', taxRateId: 'old' }, { id: 's2', taxRateId: 'old' }, { id: 's3', taxRateId: 'busy' }, { id: 's4', taxRateId: null }],
    mappings: [{ id: 'm1', taxRateId: 'old', storeIdentity: 'store-a' }, { id: 'm2', taxRateId: 'busy', storeIdentity: 'store-a' }],
  }
  const p = await plan(state, { mirrorSales: true, replaceDiffering: true })
  assert.deepEqual(p.differs.map((d) => [d.taxType, d.replaced, d.keptBecause, d.liveDocuments]).sort(), [['INPUT2', false, 'LIVE_DOCUMENTS', 1], ['OUTPUT2', true, null, 0]])
  assert.equal(p.creates.some((c) => c.taxType === 'INPUT2'), false, 'the busy rate gets no replacement')
  assert.deepEqual(p.rateSet.filter((e) => e.taxType === 'INPUT2').map((e) => e.status), ['differs'])
  await applyTo(state, p)
  const fresh = state.rates.find((r) => r.accountingTaxType === 'OUTPUT2' && r.id.startsWith('new-'))!
  assert.deepEqual(state.suppliers!.map((x) => [x.id, x.taxRateId]), [['s1', fresh.id], ['s2', fresh.id], ['s3', 'busy'], ['s4', null]], 'the old rate\'s supplier defaults follow it; the busy rate\'s do not move')
  assert.deepEqual(state.mappings!.map((x) => [x.id, x.taxRateId, x.storeIdentity]), [['m1', fresh.id, null], ['m2', 'busy', 'store-a']], 'the mapping follows and its store stamp is cleared')
  assert.equal(activeOf(state, 'old'), false)
  assert.equal(activeOf(state, 'busy'), true, 'a rate live documents depend on is not deactivated')
  // The default rate is not replaced, so its suppliers stay.
  const dflt: State = { rates: [ims('d', 'Default VAT', 'BOTH', 'OUTPUT2', { rate: '0.1500', isDefault: true })], list: XERO_LIST, suppliers: [{ id: 's1', taxRateId: 'd' }] }
  await applyTo(dflt, await plan(dflt, { mirrorSales: true, replaceDiffering: true, types: [] }))
  assert.equal(dflt.suppliers![0]!.taxRateId, 'd')
  // A document that appears between the plan and the write stops the replacement before anything moves.
  const racing: State = { rates: [ims('old', 'Old UK VAT', 'BOTH', 'OUTPUT2', { rate: '0.1500' })], list: XERO_LIST, suppliers: [{ id: 's1', taxRateId: 'old' }] }
  const planned = await plan(racing, { mirrorSales: true, replaceDiffering: true, types: [] })
  racing.rates[0]!.livePo = 1
  await assert.rejects(() => applyTo(racing, planned), PurchaseTaxImportRaceError)
  assert.deepEqual([racing.suppliers![0]!.taxRateId, activeOf(racing, 'old')], ['old', true])
  // A row that became the default rate since the plan is not replaced: the write stops, nothing is repointed.
  const turned: State = { rates: [ims('old', 'Old UK VAT', 'BOTH', 'OUTPUT2', { rate: '0.1500' })], list: XERO_LIST, suppliers: [{ id: 's1', taxRateId: 'old' }] }
  const forDefault = await plan(turned, { mirrorSales: true, replaceDiffering: true, types: [] })
  turned.rates[0]!.isDefault = true
  await assert.rejects(() => applyTo(turned, forDefault), PurchaseTaxImportRaceError)
  assert.deepEqual([turned.suppliers![0]!.taxRateId, activeOf(turned, 'old')], ['old', true])
})

const DUAL = (taxType: string, over: Partial<NormalisedXeroTaxRate> = {}): NormalisedXeroTaxRate => xeroRow(taxType, { name: `Dual ${taxType}`, expenses: true, revenue: true, ...over })

// [mutation: dual-side types left out of the sales targets -> the BOTH arm is red; the side of the new row taken as SALES / PURCHASE -> the usedFor arm is red; the dual type not added to the rate set -> the rate-set arm is red;
//  the existing-row test (`some(active && type)`) removed -> the purchase-row arm is red]
test('sales mirroring covers a Xero type usable on BOTH revenue and expenses: one BOTH row when no IMS row carries it, the SALES side when only a purchase row does, every type in the rate set', async () => {
  const state: State = { rates: stageRates(), list: [...XERO_LIST, DUAL('DUALNEW'), DUAL('DUALARCH', { status: 'ARCHIVED' })] }
  assert.deepEqual((await plan(state)).salesTypes, [], 'default: no sales side')
  const p = await plan(state, { mirrorSales: true })
  assert.deepEqual(p.salesTypes, ['DUALNEW', 'OUTPUT2', 'ZERORATEDOUTPUT'], 'an archived dual type is out of scope')
  assert.deepEqual(p.refusals, [])
  assert.deepEqual(p.creates.filter((c) => c.taxType === 'DUALNEW').map((c) => [c.side, c.name, c.rate]), [['BOTH', 'Dual DUALNEW', '0.2000']])
  assert.deepEqual(p.rateSet.filter((e) => e.taxType === 'DUALNEW').map((e) => [e.side, e.status, e.percentage]), [['BOTH', 'created', '20.000000']])
  const { calls } = await applyTo(state, p)
  assert.equal(calls.find((c) => c.op === 'create' && c.data!.accountingTaxType === 'DUALNEW')!.data!.usedFor, 'BOTH')
  // A re-run is a no-op: the BOTH row serves both sides.
  const again = await plan(state, { mirrorSales: true })
  assert.deepEqual([again.creates.length, again.refusals.length], [0, 0])
  assert.deepEqual(again.rateSet.filter((e) => e.taxType === 'DUALNEW').map((e) => e.status), ['present'])
  // An IMS row that carries the type for the purchase side only: the sales side is a target of its own (refused by name when it cannot be a second row), never silently absent.
  const purchaseOnly: State = { rates: [ims('p', 'Dual DUALP', 'PURCHASE', 'DUALP')], list: [DUAL('DUALP')] }
  const q = await plan(purchaseOnly, { mirrorSales: true, types: [] })
  assert.equal(q.creates.length, 0)
  assert.deepEqual(q.rateSet.filter((e) => e.taxType === 'DUALP').map((e) => e.side), ['SALES'])
  assert.ok(codes(q).includes('NAME_COLLISION:DUALP'))
  // A dual type whose rate cannot be taken is refused by name and appears in the rate set as missing.
  const unstated = await plan({ rates: stageRates(), list: [...XERO_LIST, DUAL('DUALBAD', { effectiveRate: null, displayTaxRate: null })] }, { mirrorSales: true })
  assert.ok(codes(unstated).includes('RATE_NOT_STATED:DUALBAD'))
  assert.deepEqual(unstated.rateSet.filter((e) => e.taxType === 'DUALBAD').map((e) => [e.side, e.status]), [['BOTH', 'missing']])
  // A dual type already in the purchase types is the purchase side's (not duplicated into the sales targets).
  assert.deepEqual((await plan({ rates: [], list: [...XERO_LIST, DUAL('DUALNEW')] }, { mirrorSales: true, types: ['DUALNEW'] })).salesTypes.includes('DUALNEW'), false)
})

// [mutation: the requested dual-side type kept as a PURCHASE target (the BOTH conversion removed) -> the BOTH arm is red; the dual-side exemption removed from the sales-target filter -> the purchase-row arm is red]
test('a dual-side type named among the requested purchase types gets ONE BOTH row when no IMS rate carries it, and a separate SALES target when only a purchase row does', async () => {
  const list = [...XERO_LIST, DUAL('DUALREQ')]
  const none = await plan({ rates: [], list }, { mirrorSales: true, types: ['DUALREQ'] })
  assert.deepEqual(none.refusals, [])
  assert.deepEqual(none.creates.filter((c) => c.taxType === 'DUALREQ').map((c) => [c.side, c.rate]), [['BOTH', '0.2000']], 'one row, usable for both sides')
  assert.deepEqual(none.rateSet.filter((e) => e.taxType === 'DUALREQ').map((e) => [e.side, e.status]), [['BOTH', 'created']])
  assert.equal(none.salesTypes.includes('DUALREQ'), false)
  const sales = await plan({ rates: [], list }, { types: ['DUALREQ'] })
  assert.deepEqual(sales.creates.map((c) => [c.taxType, c.side]), [['DUALREQ', 'PURCHASE']], 'without sales mirroring the request stays a purchase row')
  const purchaseRow = await plan({ rates: [ims('p', 'Old purchase', 'PURCHASE', 'DUALREQ')], list }, { mirrorSales: true, types: ['DUALREQ'] })
  assert.deepEqual(purchaseRow.creates.filter((c) => c.taxType === 'DUALREQ').map((c) => c.side), ['SALES'], 'a separate sales row is planned and validated')
  assert.deepEqual(purchaseRow.rateSet.filter((e) => e.taxType === 'DUALREQ').map((e) => e.side).sort(), ['PURCHASE', 'SALES'])
})

// [mutation: the shared-BOTH-row conversion removed (sharedBothRow left empty) -> two replacements from one old row: the one-create arm and the applied arm are red; the SALES skip removed -> a second create / NAME_COLLISION: red;
//  the BOTH row test (`usedFor === 'BOTH'`) dropped -> a purchase-only row is replaced as BOTH: the purchase-only arm is red]
test('replaceDiffering with mirrorSales: ONE differing BOTH row serving a requested dual-side type gets ONE BOTH replacement, applied, and the old row is deactivated only with it', async () => {
  const list = [...XERO_LIST, DUAL('DUALREQ', { effectiveRate: '25.000000', displayTaxRate: '25.000000', components: [{ name: 'VAT', rate: '25.000000', compound: false, nonRecoverable: false }] })]
  const old = (): State => ({ rates: [ims('b', 'Old dual', 'BOTH', 'DUALREQ', { rate: '0.1500' })], list, suppliers: [{ id: 's1', taxRateId: 'b' }] })
  const options = { mirrorSales: true, replaceDiffering: true, types: ['DUALREQ'] }
  const state = old()
  const p = await plan(state, options)
  assert.deepEqual(p.refusals.filter((r) => r.taxType === 'DUALREQ'), [], 'no collision between two replacements')
  assert.deepEqual(p.creates.filter((c) => c.taxType === 'DUALREQ').map((c) => [c.side, c.replaces, c.rate]), [['BOTH', 'b', '0.2500']], 'one replacement covering both sides')
  assert.deepEqual(p.differs.filter((d) => d.taxType === 'DUALREQ').map((d) => [d.id, d.replaced]), [['b', true]], 'the old row is reported once')
  assert.deepEqual(p.rateSet.filter((e) => e.taxType === 'DUALREQ').map((e) => e.side).sort(), ['PURCHASE', 'SALES'], 'both sides stay in the rate set')
  // APPLIED (the case the report is about: requireAll is off, so whatever the plan holds is written).
  const { calls } = await applyTo(state, p)
  assert.equal(calls.filter((c) => c.op === 'create' && c.data!.accountingTaxType === 'DUALREQ').length, 1, 'one create from the one old row')
  assert.deepEqual(state.rates.filter((r) => r.accountingTaxType === 'DUALREQ' && r.active).map((r) => [r.usedFor, r.rate]), [['BOTH', '0.2500']], 'an active row usable for sales (and purchases) remains')
  assert.equal(state.rates.find((r) => r.id === 'b')!.active, false)
  assert.equal(state.suppliers![0]!.taxRateId, state.rates.find((r) => r.accountingTaxType === 'DUALREQ' && r.active)!.id, 'the supplier default follows the replacement')
  const again = await plan(state, options)
  assert.deepEqual([again.creates.filter((c) => c.taxType === 'DUALREQ').length, again.differs.filter((d) => d.taxType === 'DUALREQ').length], [0, 0], 'a re-run has nothing to do for the type')
  // A purchase-only row (not a BOTH row) is not one row for both targets: the purchase target replaces it and the sales target stays its own (refused by name here, as before).
  const purchaseOnly = await plan({ rates: [ims('p', 'Old purchase', 'PURCHASE', 'DUALREQ', { rate: '0.1500' })], list }, options)
  assert.deepEqual(purchaseOnly.creates.filter((c) => c.taxType === 'DUALREQ').map((c) => c.side), ['PURCHASE'], 'not converted to BOTH')
  // Two DIFFERENT rows for the type (one purchase-only, one sales-only) are not one row serving both targets: no BOTH replacement.
  const split = await plan({ rates: [ims('p', 'Old purchase', 'PURCHASE', 'DUALREQ', { rate: '0.1500' }), ims('sl', 'Old sales', 'SALES', 'DUALREQ', { rate: '0.1500' })], list }, options)
  assert.ok(split.creates.filter((c) => c.taxType === 'DUALREQ').every((c) => c.side !== 'BOTH'), 'separate rows stay separate')
  // The BOTH row is kept (not replaced) while live documents depend on it: no create, no deactivation, no half-replacement.
  const held: State = { rates: [ims('b', 'Old dual', 'BOTH', 'DUALREQ', { rate: '0.1500', live: 2 })], list }
  const kept = await plan(held, options)
  assert.deepEqual(kept.creates.filter((c) => c.taxType === 'DUALREQ'), [])
  assert.ok(kept.differs.filter((d) => d.taxType === 'DUALREQ').every((d) => !d.replaced && d.keptBecause === 'LIVE_DOCUMENTS'))
  await applyTo(held, kept)
  assert.equal(held.rates.find((r) => r.id === 'b')!.active, true)
  // A BOTH row at Xero's percentage needs nothing.
  const same = await plan({ rates: [ims('b', 'Old dual', 'BOTH', 'DUALREQ', { rate: '0.2500' })], list }, options)
  assert.deepEqual(same.creates.filter((c) => c.taxType === 'DUALREQ'), [])
})

// [mutation: the re-read of the locked row removed (identity not compared) -> the rename arms are red; the recount using the PLANNED name instead of the row's current one -> the rename-plus-order arm is red;
//  the narrowing's lock-and-compare removed -> the narrow arm is red; the replaced row's compare removed -> the replace arm is red]
test('a row renamed (or otherwise changed) between the plan and the lock is not written: deactivation, replacement and narrowing each stop, and the recount uses the row\'s CURRENT name', async () => {
  // Deactivation: renamed to a name that a live order uses.
  const rates = (): ImsRow[] => [ims('free', 'Demo free', 'BOTH', 'TAX001'), ims('other', 'Demo other', 'BOTH', 'TAX002', { named: 2 })]
  const state: State = { rates: rates(), list: XERO_LIST }
  const p = await plan(state, { deactivateAbsent: true })
  assert.equal(p.notInXero.find((r) => r.id === 'free')!.deactivate, true)
  state.rates.find((r) => r.id === 'free')!.name = 'Demo other'
  await assert.rejects(() => applyTo(state, p), PurchaseTaxImportRaceError)
  assert.equal(activeOf(state, 'free'), true, 'renamed since the plan: not deactivated')
  // Each other identity field.
  for (const [label, change] of [['percentage', (r: ImsRow) => { r.rate = '0.1000' }], ['sides', (r: ImsRow) => { r.usedFor = 'SALES' }], ['active', (r: ImsRow) => { r.active = false }]] as const) {
    const s2: State = { rates: rates(), list: XERO_LIST }
    const planned = await plan(s2, { deactivateAbsent: true })
    change(s2.rates.find((r) => r.id === 'free')!)
    await assert.rejects(() => applyTo(s2, planned), PurchaseTaxImportRaceError, label)
  }
  // The recount uses the CURRENT name: the plan saw no order for 'Demo free'; after the rename the order names the new name.
  const s3: State = { rates: [ims('free', 'Demo free', 'BOTH', 'TAX001'), ims('o', 'Elsewhere', 'BOTH', 'TAX002')], list: XERO_LIST }
  const planned3 = await plan(s3, { deactivateAbsent: true })
  s3.rates[0]!.name = 'Renamed'
  s3.rates[1]!.named = 0
  s3.rates.push(ims('x', 'Renamed', 'BOTH', 'TAX009', { named: 1 }))
  planned3.notInXero[0]!.identity = JSON.stringify(['Renamed', '0.2000', 'BOTH', true, []])
  await assert.rejects(() => applyTo(s3, planned3), PurchaseTaxImportRaceError, 'the order naming the CURRENT name stops it')
  // Replacement.
  const rep: State = { rates: [ims('old', 'Old UK VAT', 'BOTH', 'OUTPUT2', { rate: '0.1500' })], list: XERO_LIST, suppliers: [{ id: 's1', taxRateId: 'old' }] }
  const planRep = await plan(rep, { mirrorSales: true, replaceDiffering: true, types: [] })
  rep.rates[0]!.name = 'Renamed old'
  await assert.rejects(() => applyTo(rep, planRep), PurchaseTaxImportRaceError)
  assert.deepEqual([rep.suppliers![0]!.taxRateId, activeOf(rep, 'old')], ['old', true])
  // Narrowing.
  const nar: State = { rates: stageRates(), list: XERO_LIST }
  const planNar = await plan(nar, { narrowSalesTypes: true })
  nar.rates.find((r) => r.id === 'uk')!.name = 'Renamed UK'
  await assert.rejects(() => applyTo(nar, planNar), PurchaseTaxImportRaceError)
  assert.equal(nar.rates.find((r) => r.id === 'uk')!.usedFor, 'BOTH')
})

// [mutation: the seeded SALES defaults taken as SALES without the dual-side classification -> red]
test('a seeded sales default (OUTPUT2, ZERORATEDOUTPUT) that Xero lists as active on BOTH sides, with no IMS row, is ONE BOTH row', async () => {
  const list = XERO_LIST.map((r) => (r.taxType === 'OUTPUT2' ? { ...r, canApply: { ...r.canApply, expenses: true, revenue: true } } : r))
  const p = await plan({ rates: [], list }, { mirrorSales: true, types: [] })
  assert.deepEqual(p.creates.filter((c) => c.taxType === 'OUTPUT2').map((c) => c.side), ['BOTH'])
  assert.deepEqual(p.creates.filter((c) => c.taxType === 'ZERORATEDOUTPUT').map((c) => c.side), ['SALES'], 'a revenue-only default stays SALES')
  const withRow = await plan({ rates: [ims('o', 'Old out', 'PURCHASE', 'OUTPUT2')], list }, { mirrorSales: true, types: [] })
  assert.deepEqual(withRow.rateSet.filter((e) => e.taxType === 'OUTPUT2').map((e) => e.side), ['SALES'], 'with a purchase-only row it is a SALES target')
})
