import assert from 'node:assert/strict'
import test from 'node:test'

import {
  describeRefusals, planPurchaseTaxImport, readStoredXeroList, writePurchaseTaxImport,
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

type ImsRow = { id: string; name: string; rate: string; usedFor: string; active: boolean; accountingTaxType: string | null; isDefault: boolean; refs?: number }
type State = { rates: ImsRow[]; list: NormalisedXeroTaxRate[] | null; tenant?: string; fetchedAt?: Date; stamp?: string | null; headerDigest?: string; settings?: Record<string, string>; rowCount?: number }

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
    taxRate: {
      findMany: async () => state.rates.map((r) => ({
        id: r.id, name: r.name, rate: decimal(r.rate), usedFor: r.usedFor, active: r.active, accountingTaxType: r.accountingTaxType, isDefault: r.isDefault,
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
    taxRate: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push({ op: 'create', data })
        state.rates.push(ims(`new-${state.rates.length}`, data.name as string, data.usedFor as string, data.accountingTaxType as string, { rate: data.rate as string }))
        return {}
      },
      updateMany: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.push({ op: 'updateMany', where, data })
        const row = state.rates.find((r) => r.id === where.id)!
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
