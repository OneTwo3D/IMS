import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  assertFreightTotalNotNegative,
  buildFreightCostLineRows,
  FreightNetCreditError,
  persistedAmountForeign,
  freightTotalIsNegative,
  CreateFreightPoInputSchema,
  FREIGHT_NET_CREDIT_MESSAGE,
  FreightCostLinesSchema,
  FreightEditRefusedError,
  FREIGHT_TAX_RATE_UNKNOWN_MESSAGE,
  FREIGHT_BILLED_VAT_CHANGE_MESSAGE,
  planFreightCostLineEdit,
  resolveFreightEditTaxRate,
  type StoredFreightCostLine,
  type FreightCostLineInput,
} from '@/lib/domain/purchasing/freight-cost-lines'

/**
 * The boundary for a freight order's cost lines (both `createFreightPo` and `updateFreightPoCosts`).
 *
 * Two layers of proof. The schema/builder arms pin WHAT is accepted. The action arms prove the boundary is
 * actually WIRED into both actions: a rejected call must never reach the database, and a recorder that has
 * been shown to see a database call (the positive control) is what makes "reached nothing" mean something.
 */

const GOOD: FreightCostLineInput = { description: 'Sea freight', amountForeign: 20, vatable: false, distributionMethod: 'BY_VALUE' }
const line = (over: Partial<FreightCostLineInput>): FreightCostLineInput => ({ ...GOOD, ...over })

// ─── The database recorder: any model call is a "touch", and a transaction is a hard stop ───────────────

const touches: string[] = []
function recordingDb(path: string[] = []): unknown {
  return new Proxy(function recorded() {}, {
    get(_target, key) {
      if (key === 'then') return undefined
      return recordingDb([...path, String(key)])
    },
    apply(_target, _this, args) {
      const name = path.join('.')
      touches.push(name)
      // A transaction would run the real action body against a database that does not exist here.
      if (name === '$transaction') throw new Error('RECORDER: a transaction was opened')
      void args
      return Promise.resolve(null)
    },
  })
}
mock.module('@/lib/db', { namedExports: { db: recordingDb() } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    freshAuthFailureResult: () => null,
    requireApiFreshAdmin: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })

const baseCreate = {
  supplierId: 's1',
  currency: 'GBP',
  fxRateToBase: 1,
  primaryPoIds: ['po-1'],
  costLines: [GOOD],
}

// ─── Schema ──────────────────────────────────────────────────────────────────────────────────────────────

test('T11 schema: finite signed numbers, the four methods, fx above zero — and the net-subtotal rule', () => {
  const bad: Array<[string, unknown]> = [
    ['NaN amount', [line({ amountForeign: Number.NaN })]],
    ['Infinity amount', [line({ amountForeign: Number.POSITIVE_INFINITY })]],
    ['string amount', [{ ...GOOD, amountForeign: '20' }]],
    ['null amount', [{ ...GOOD, amountForeign: null }]],
    ['unknown method', [line({ distributionMethod: 'BY_COLOUR' })]],
    ['missing method', [{ description: 'x', amountForeign: 1, vatable: false }]],
    ['non-boolean vatable', [{ ...GOOD, vatable: 'yes' }]],
    ['net credit', [line({ amountForeign: 10 }), line({ amountForeign: -10.01 })]],
    ['only a credit', [line({ amountForeign: -5 })]],
  ]
  let rejected = 0
  for (const [label, lines] of bad) {
    assert.equal(FreightCostLinesSchema.safeParse(lines).success, false, `${label} must be rejected`)
    rejected += 1
  }
  const net = FreightCostLinesSchema.safeParse([line({ amountForeign: -5 })])
  assert.equal(net.success ? '' : net.error.issues[0].message, FREIGHT_NET_CREDIT_MESSAGE)
  assert.match(FREIGHT_NET_CREDIT_MESSAGE, /supplier credit note/)

  const accepted: Array<[string, unknown]> = [
    ['+20 and -5', [line({ amountForeign: 20 }), line({ amountForeign: -5 })]],
    ['a zero line', [line({ amountForeign: 0 })]],
    ['zero net', [line({ amountForeign: 5 }), line({ amountForeign: -5 })]],
    ['empty (clears the lines)', []],
  ]
  for (const [label, lines] of accepted) assert.equal(FreightCostLinesSchema.safeParse(lines).success, true, `${label} must be accepted`)
  console.log(`T11 PRECONDITION: rejected ${rejected} malformed/net-negative shapes, accepted ${accepted.length} deliberate shapes`)

  for (const fx of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(CreateFreightPoInputSchema.safeParse({ ...baseCreate, fxRateToBase: fx }).success, false, `fx ${fx}`)
  }
  assert.equal(CreateFreightPoInputSchema.safeParse({ ...baseCreate, taxRateValue: -0.2 }).success, false)
  assert.equal(CreateFreightPoInputSchema.safeParse({ ...baseCreate, costLines: [] }).success, false)
  assert.equal(CreateFreightPoInputSchema.safeParse({ ...baseCreate, primaryPoIds: [] }).success, false)
  assert.equal(CreateFreightPoInputSchema.safeParse(baseCreate).success, true)
})

test('T11 builder: 4dp HALF_UP Decimal rows and totals, and the case where the old float builder differed', () => {
  // 0.1309 / 2 = 0.06545 exactly: HALF_UP gives 0.0655, while the float expression the pre-boundary
  // createFreightPo used (`Math.round((x / fx) * 10000) / 10000`) lands below the half and gives 0.0654. The
  // two actions therefore used to persist DIFFERENT amountBase for the same input.
  const floatAmountBase = Math.round((0.1309 / 2) * 10000) / 10000
  const parity = buildFreightCostLineRows([line({ amountForeign: 0.1309 })], 2, 0)
  console.log(`T11 PRECONDITION: float builder amountBase=${floatAmountBase}, shared builder amountBase=${parity.rows[0].amountBase}`)
  assert.equal(floatAmountBase, 0.0654, 'the fixture must be a case where the float builder differs')
  assert.equal(parity.rows[0].amountBase.toString(), '0.0655')

  const lines = [
    line({ amountForeign: 100, vatable: true }),
    line({ amountForeign: 0.1, vatable: true, distributionMethod: 'BY_QUANTITY' }),
    line({ amountForeign: -5 }),
  ]
  const built = buildFreightCostLineRows(lines, 0.3, 0.2)
  assert.equal(built.rows[0].amountBase.toString(), '333.3333')
  assert.equal(built.rows[1].amountBase.toString(), '0.3333')
  assert.equal(built.rows[2].amountBase.toString(), '-16.6667')
  assert.equal(built.subtotalForeign.toString(), '95.1')
  assert.equal(built.taxForeign.toString(), '20.02')
  assert.equal(built.totalForeign.toString(), '115.12')
  assert.deepEqual(built.rows.map((row) => row.sortOrder), [0, 1, 2])
  for (const row of built.rows) {
    assert.ok(row.amountForeign instanceof Prisma.Decimal && row.amountBase instanceof Prisma.Decimal)
  }
  // A second call is byte-identical: there is one builder.
  const again = buildFreightCostLineRows(lines, new Prisma.Decimal('0.3'), new Prisma.Decimal('0.2'))
  assert.equal(JSON.stringify(again), JSON.stringify(built))
})

// ─── The actions: the boundary is wired in, and a rejected call reaches nothing ─────────────────────────

test('T11 actions: both actions refuse the same bad input BEFORE touching the database; a valid call does reach it', async () => {
  const { createFreightPo, updateFreightPoCosts } = await import('@/app/actions/purchase-orders')

  // POSITIVE CONTROL. A valid create reaches the database (it reads for a reference first), so the recorder
  // is demonstrably wired to the module under test; without this "touched nothing" would be vacuous.
  touches.length = 0
  const control = await createFreightPo(baseCreate)
  console.log(`T11 PRECONDITION (positive control): valid createFreightPo touched the database ${touches.length} time(s): ${touches.slice(0, 3).join(', ')}`)
  assert.equal(touches.length > 0, true, 'the recorder did not see a valid call reach the database')
  assert.equal(control.success, false, 'the recorder database cannot complete a creation, which is the point of it')

  const badLineSets: Array<[string, unknown[]]> = [
    ['NaN', [line({ amountForeign: Number.NaN })]],
    ['Infinity', [line({ amountForeign: Number.POSITIVE_INFINITY })]],
    ['non-number', [{ ...GOOD, amountForeign: '20' }]],
    ['unknown method', [line({ distributionMethod: 'BY_COLOUR' })]],
    ['net-negative subtotal', [line({ amountForeign: 5 }), line({ amountForeign: -9 })]],
  ]
  let create = 0
  let update = 0
  for (const [label, costLines] of badLineSets) {
    touches.length = 0
    const created = await createFreightPo({ ...baseCreate, costLines: costLines as never })
    assert.equal(created.success, false, `create ${label}`)
    assert.deepEqual(touches, [], `create ${label}: the database was reached`)
    create += 1

    touches.length = 0
    const updated = await updateFreightPoCosts('freight-1', costLines as never)
    assert.equal(updated.success, false, `update ${label}`)
    assert.deepEqual(touches, [], `update ${label}: the database was reached`)
    update += 1
  }
  // fx at the action boundary (create only: update reads the stored rate).
  for (const fx of [0, -2, Number.NaN]) {
    touches.length = 0
    const created = await createFreightPo({ ...baseCreate, fxRateToBase: fx })
    assert.equal(created.success, false, `create fx ${fx}`)
    assert.deepEqual(touches, [])
  }
  console.log(`T11 PRECONDITION: rejected before any database touch: create x${create + 3}, update x${update}`)
  // The net-negative message is the operator's reason.
  const net = await updateFreightPoCosts('freight-1', [line({ amountForeign: -3 })])
  assert.equal(net.error, FREIGHT_NET_CREDIT_MESSAGE)
})

// ─── Census: one builder, no float builder, types derived from the schema ───────────────────────────────

test('T11 census: both actions parse with the shared boundary and build rows with the ONE builder', () => {
  const source = readFileSync('app/actions/purchase-orders.ts', 'utf8')
  const builderCalls = (source.match(/\bbuildFreightCostLineRows\(/g) ?? []).length
  const schemaCalls = (source.match(/CreateFreightPoInputSchema\.safeParse\(|FreightCostLinesSchema\.safeParse\(/g) ?? []).length
  console.log(`T11 PRECONDITION: buildFreightCostLineRows calls=${builderCalls}, schema parses=${schemaCalls}`)
  assert.equal(builderCalls, 2, 'createFreightPo and updateFreightPoCosts each build rows through the one builder')
  assert.equal(schemaCalls, 2, 'each action parses its input through the shared boundary')
  // No float cost-line builder left anywhere in the action file (the pre-boundary create path).
  assert.equal(/Math\.round\(\(cl\.amountForeign/.test(source), false)
  assert.equal(/input\.fxRateToBase \|\| 1/.test(source), false, 'the silent `|| 1` exchange-rate default is gone')
  // The input types are DERIVED from the schema, not restated.
  assert.equal(/export type FreightCostLineInput = \{/.test(source), false)
  assert.equal(/export type \{[^}]*(FreightCostLineInput|CreateFreightPoInput)/.test(source), false, "a type re-export in a 'use server' file fails the Turbopack build")
  assert.equal(/export type CreateFreightPoInput = \{/.test(source), false)
})

test('T11 total: the payable total (net PLUS VAT) is what must not be negative, with exact Decimal math', () => {
  const lines = [
    line({ amountForeign: 100, vatable: false }),
    line({ amountForeign: -100, vatable: true }),
  ]
  const built = buildFreightCostLineRows(lines, 1, 0.2)
  console.log(`T11 PRECONDITION: subtotal=${built.subtotalForeign}, tax=${built.taxForeign}, total=${built.totalForeign} (the line-sum rule alone passes this: ${FreightCostLinesSchema.safeParse(lines).success})`)
  assert.equal(FreightCostLinesSchema.safeParse(lines).success, true, 'the line-sum rule cannot see VAT')
  assert.equal(built.totalForeign.toString(), '-20')
  assert.equal(freightTotalIsNegative(built), true)
  assert.throws(() => assertFreightTotalNotNegative(built), FreightNetCreditError)
  const fine = buildFreightCostLineRows([line({ amountForeign: 100 }), line({ amountForeign: -50, vatable: true })], 1, 0.2)
  assert.equal(fine.totalForeign.toString(), '40')
  assert.equal(freightTotalIsNegative(fine), false)
  // Exactly zero is allowed.
  assert.equal(freightTotalIsNegative(buildFreightCostLineRows([line({ amountForeign: 5 }), line({ amountForeign: -5 })], 1, 0)), false)
})

test('T11 rounding: validation uses the amounts AS PERSISTED (4dp, half away from zero), not the raw input', () => {
  // -0.00004 is stored as 0.0000: a zero line, not a credit. The raw-sum rule would have refused it.
  const tiny = [line({ amountForeign: -0.00004 })]
  assert.equal(persistedAmountForeign(-0.00004).isZero(), true)
  const built = buildFreightCostLineRows(tiny, 1, 0)
  console.log(`T11 PRECONDITION: raw net -0.00004, persisted net ${built.subtotalForeign}, row amount ${built.rows[0].amountForeign}`)
  assert.equal(FreightCostLinesSchema.safeParse(tiny).success, true, 'a line that is stored as zero is a zero line')
  assert.equal(built.rows[0].amountForeign.toString(), '0')
  assert.equal(freightTotalIsNegative(built), false)
  // -0.00005 is stored as -0.0001: a real (tiny) credit, refused as a net credit.
  assert.equal(persistedAmountForeign(-0.00005).toString(), '-0.0001')
  assert.equal(FreightCostLinesSchema.safeParse([line({ amountForeign: -0.00005 })]).success, false)
  // The row's base amount is derived from the PERSISTED amount, so row and total cannot disagree.
  const row = buildFreightCostLineRows([line({ amountForeign: 0.00005 })], 2, 0).rows[0]
  assert.equal(row.amountForeign.toString(), '0.0001')
  assert.equal(row.amountBase.toString(), '0.0001')
})

test('UI census: the freight dialog sends credit/zero lines back instead of dropping them', () => {
  const ui = readFileSync('app/(dashboard)/purchase-orders/[id]/po-detail-client.tsx', 'utf8')
  const start = ui.indexOf('function EditFreightCostsDialog')
  const dialog = ui.slice(start, ui.indexOf('\nfunction ', start + 10) === -1 ? undefined : ui.indexOf('\nfunction ', start + 10))
  console.log(`UI PRECONDITION: dialog source ${dialog.length} chars; lockedLines mentions: ${(dialog.match(/lockedLines/g) ?? []).length}`)
  assert.ok(dialog.length > 500)
  assert.ok((dialog.match(/lockedLines/g) ?? []).length >= 4, 'locked (credit/zero) lines are kept, shown and sent back')
  assert.match(dialog, /\.\.\.lockedLines\.map\(\(cl\) => \(\{\s+id: cl\.id,\s+description: cl\.description,/, 'locked lines are sent back to the server, by id')
  assert.match(dialog, /\.\.\.\(cl\.id \? \{ id: cl\.id \} : \{\}\),/, 'edited stored lines are sent with their stored id')
  // The VAT rate is an input of the save: the dialog passes the chosen rate as the third argument (none for a legacy
  // order it must not guess for), so a save is never left at two arguments.
  assert.match(dialog, /taxRateId === '__recorded' \|\| taxRateId === '__unset'\s+\? undefined\s+: \(purchaseTaxRates\.find\(\(t\) => t\.id === taxRateId\)\?\.rate \?\? 0\)/, 'the dialog passes the chosen VAT rate as the third argument')
})


// ─── Editing stored lines: matched by id, billed rows untouchable ────────────────────────────────────────

const stored = (id: string, amount: string, over: Partial<StoredFreightCostLine> = {}): StoredFreightCostLine => ({
  id, description: `line ${id}`, amountForeign: new Prisma.Decimal(amount), vatable: false, distributionMethod: 'BY_VALUE', billed: false, ...over,
})
const submit = (id: string | undefined, amount: number, over: Partial<FreightCostLineInput> = {}): FreightCostLineInput =>
  ({ ...(id ? { id } : {}), description: `line ${id}`, amountForeign: amount, vatable: false, distributionMethod: 'BY_VALUE', ...over })
const plan = (storedRows: StoredFreightCostLine[], submitted: FreightCostLineInput[], taxChanged = false) =>
  planFreightCostLineEdit(storedRows, submitted, buildFreightCostLineRows(submitted, 1).rows, taxChanged)

test('edit plan: a billed row cannot be changed, removed, or replaced by an id-less save; an unbilled one can', () => {
  const rows = [stored('a', '30', { billed: true }), stored('b', '20')]
  console.log(`plan PRECONDITION: ${rows.length} stored rows, billed=${rows.filter((r) => r.billed).map((r) => r.id).join(',')}`)
  assert.throws(() => plan(rows, [submit('a', 31), submit('b', 20)]), (e: unknown) => e instanceof FreightEditRefusedError && /billed and cannot be changed/.test(e.message))
  assert.throws(() => plan(rows, [submit('b', 20)]), (e: unknown) => e instanceof FreightEditRefusedError && /billed and cannot be removed/.test(e.message))
  assert.throws(() => plan(rows, [submit(undefined, 99)]), (e: unknown) => e instanceof FreightEditRefusedError && /billed and cannot be replaced/.test(e.message))
  const ok = plan(rows, [submit('a', 30), submit('b', 21)])
  assert.equal(ok.kind, 'apply')
  assert.deepEqual(ok.kind === 'apply' ? ok.updates.map((u) => u.id) : [], ['b'])
  // Reordered, unchanged, billed row present: a no-op, not a refusal.
  assert.equal(plan(rows, [submit('b', 20), submit('a', 30)]).kind, 'noop')
})

test('edit plan: matched by id not position; unknown or repeated ids refused; new rows created; omitted unbilled rows deleted', () => {
  const rows = [stored('a', '30'), stored('b', '20')]
  const swapped = plan(rows, [submit('b', 25), submit('a', 30)])
  assert.equal(swapped.kind, 'apply')
  assert.deepEqual(swapped.kind === 'apply' ? swapped.updates.map((u) => u.id) : [], ['b'])
  assert.throws(() => plan(rows, [submit('zzz', 1)]), FreightEditRefusedError)
  assert.throws(() => plan(rows, [submit('a', 30), submit('a', 30)]), FreightEditRefusedError)
  const mixed = plan(rows, [submit('a', 30), submit(undefined, 5)])
  assert.equal(mixed.kind === 'apply' ? mixed.creates.length : -1, 1)
  assert.deepEqual(mixed.kind === 'apply' ? mixed.deletes : [], ['b'])
})

test('edit plan: a tax-only change is an edit, the same lines and tax are a no-op', () => {
  const rows = [stored('a', '30')]
  assert.equal(plan(rows, [submit('a', 30)], false).kind, 'noop')
  assert.equal(plan(rows, [submit('a', 30)], true).kind, 'apply')
})

// ─── Which VAT rate an edit saves at ─────────────────────────────────────────────────────────────────────

test('edit tax rate: none sent keeps the stored rate; a different one is a tax change; an unrecorded rate on a charged order is refused, never inferred', () => {
  const kept = resolveFreightEditTaxRate({ requested: undefined, storedRate: '0.2', storedTaxForeign: '20' })
  console.log(`rate PRECONDITION: none sent, stored 0.2 -> ${kept.effectiveRate} changed=${kept.taxChanged}`)
  assert.equal(kept.effectiveRate.toString(), '0.2')
  assert.equal(kept.taxChanged, false)
  const changed = resolveFreightEditTaxRate({ requested: 0.1, storedRate: '0.2', storedTaxForeign: '20' })
  assert.equal(changed.effectiveRate.toString(), '0.1')
  assert.equal(changed.taxChanged, true)
  const sameRate = resolveFreightEditTaxRate({ requested: 0.2, storedRate: '0.2000', storedTaxForeign: '20' })
  assert.equal(sameRate.taxChanged, false)
  // Unrecorded rate, no VAT charged: zero, unchanged.
  const none = resolveFreightEditTaxRate({ requested: undefined, storedRate: null, storedTaxForeign: '0' })
  assert.equal(none.effectiveRate.toString(), '0')
  assert.equal(none.taxChanged, false)
  // Unrecorded rate but VAT was charged (legacy row): refused with the single-sourced text; supplying a rate resolves it.
  assert.throws(
    () => resolveFreightEditTaxRate({ requested: undefined, storedRate: null, storedTaxForeign: '20' }),
    (e: unknown) => e instanceof FreightEditRefusedError && e.message === FREIGHT_TAX_RATE_UNKNOWN_MESSAGE,
  )
  const supplied = resolveFreightEditTaxRate({ requested: 0.2, storedRate: null, storedTaxForeign: '20' })
  assert.equal(supplied.effectiveRate.toString(), '0.2')
})


test('edit plan: on an order with ANY billed line a VAT-rate or vatable-flag change is refused (even when every line is billed and unchanged); on an unbilled order it is allowed', () => {
  const allBilled = [stored('a', '30', { billed: true }), stored('b', '20', { billed: true })]
  const someBilled = [stored('a', '30', { billed: true }), stored('b', '20')]
  const unbilled = [stored('a', '30'), stored('b', '20')]
  const unchangedLines = [submit('a', 30), submit('b', 20)]
  const refusal = (e: unknown) => e instanceof FreightEditRefusedError && e.message === FREIGHT_BILLED_VAT_CHANGE_MESSAGE
  console.log('billed-vat PRECONDITION: tax-only edit with every line billed / one billed / none billed')
  assert.throws(() => plan(allBilled, unchangedLines, true), refusal)
  assert.throws(() => plan(someBilled, unchangedLines, true), refusal)
  assert.equal(plan(unbilled, unchangedLines, true).kind, 'apply')
  // Flipping the vatable flag of an UNBILLED line on an order that has a billed line changes the order VAT too.
  assert.throws(() => plan(someBilled, [submit('a', 30), submit('b', 20, { vatable: true })], false), refusal)
  assert.equal(plan(unbilled, [submit('a', 30), submit('b', 20, { vatable: true })], false).kind, 'apply')
  // An unchanged save of a fully billed order is still fine.
  assert.equal(plan(allBilled, unchangedLines, false).kind, 'noop')
})
