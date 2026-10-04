import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  buildFreightCostLineRows,
  CreateFreightPoInputSchema,
  FREIGHT_NET_CREDIT_MESSAGE,
  FreightCostLinesSchema,
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
