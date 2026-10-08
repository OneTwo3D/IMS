import assert from 'node:assert/strict'
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  allocateLandedCost,
  floorUnitCostAtZero,
  unabsorbedBaseForQty,
  type LandedAllocationCostLine,
  type LandedAllocationLine,
} from '@/lib/domain/purchasing/landed-cost-allocation'
import {
  computeGrossUnitCostBaseByLine,
  computeLandedCostForPendingLines,
} from '@/lib/domain/purchasing/landed-cost-service'
import {
  describeFlooredLandedCredit,
  totalUnabsorbedBase,
  type FlooredLandedCreditEntry,
} from '@/lib/domain/purchasing/landed-cost-floor-text'

/**
 * Landed-cost allocation: ONE core, and what it must do with a credit or zero cost line.
 *
 * Every arm asserts AND prints its precondition, so a fixture that never reached the behaviour cannot pass
 * for a proof. The arms that go through `computeGrossUnitCostBaseByLine` (the receipt-side entry point that
 * existed before the core) are the ones that are RED on the trunk the fix started from: it skipped every
 * non-positive cost line and had no floor.
 */

const D = (value: string | number) => new Prisma.Decimal(value)

function line(id: string, qty: number, unitCostBase: number, weight: number | null = null): LandedAllocationLine {
  return { id, qty, unitCostBase, totalBase: qty * unitCostBase, weight }
}

function cost(
  amountBase: string | number,
  distributionMethod = 'BY_VALUE',
  sourceRank: 0 | 1 = 0,
  id: string | null = null,
): LandedAllocationCostLine {
  return { id, amountBase, distributionMethod, sourceRank }
}

const asNumbers = (gross: Map<string, Prisma.Decimal>) => Object.fromEntries([...gross].map(([id, value]) => [id, value.toNumber()]))

// ─── T1 / T2 / T7: the sign rule, the floor and the signed zero ─────────────────────────────────────────

test('T1: a credit cost line is APPLIED, by the core and by the receipt-side entry point alike', () => {
  const lines = [line('A', 1, 10), line('B', 1, 10)]
  const core = allocateLandedCost(lines, [cost(-4)])
  console.log(`T1 PRECONDITION: credit lines distributed: 1, landed amounts: A=${core.landedAmountByLine.get('A')}, B=${core.landedAmountByLine.get('B')}`)
  assert.equal(core.landedAmountByLine.get('A')?.toString(), '-2')
  assert.deepEqual(asNumbers(core.grossUnitCostBaseByLine), { A: 8, B: 8 })

  // The wrapper the receipt, the preview, the WMS book-in and the align-up call. On the trunk this skipped the
  // credit (`amountBase.lte(0)) continue`) and answered 10 / 10.
  const viaWrapper = computeGrossUnitCostBaseByLine({
    lines: lines.map((l) => ({ ...l })),
    directCostLines: [{ amountBase: -4, distributionMethod: 'BY_VALUE' }],
  })
  assert.deepEqual(asNumbers(viaWrapper), { A: 8, B: 8 })
})

test('T1b: a ZERO cost line distributes zero by arithmetic and warns about nothing', () => {
  const core = allocateLandedCost([line('A', 1, 10), line('B', 1, 10, 0)], [cost(0, 'BY_WEIGHT')])
  console.log(`T1b PRECONDITION: zero BY_WEIGHT line over all-zero weights; events: ${JSON.stringify(core.events)}`)
  assert.deepEqual(asNumbers(core.grossUnitCostBaseByLine), { A: 10, B: 10 })
  assert.deepEqual(core.events, [], 'a zero line moves no money, so a fallback warning on it would describe an allocation that never happened')
})

test('T2: the floor — a credit larger than the goods cost values the unit at ZERO and reports the residue', () => {
  const lines = [line('A', 1, 1)]
  const core = allocateLandedCost(lines, [cost(-3)])
  console.log(`T2 PRECONDITION: floors: ${core.floors.length}, unfloored gross: ${core.floors[0]?.unflooredGrossUnitCostBase}, gross: ${core.grossUnitCostBaseByLine.get('A')}`)
  assert.equal(core.floors.length, 1)
  assert.equal(core.floors[0].lineId, 'A')
  assert.equal(core.floors[0].unflooredGrossUnitCostBase.toString(), '-2')
  assert.equal(core.floors[0].unabsorbedPerUnitBase.toString(), '2')
  assert.equal(core.grossUnitCostBaseByLine.get('A')?.toString(), '0')

  // Receipt-side entry point: the trunk answered 1 (credit skipped), so this is red there as well.
  const viaWrapper = computeGrossUnitCostBaseByLine({
    lines: lines.map((l) => ({ ...l })),
    directCostLines: [{ amountBase: -3, distributionMethod: 'BY_VALUE' }],
  })
  assert.equal(viaWrapper.get('A')?.toString(), '0')
  const full = computeLandedCostForPendingLines({
    lines: lines.map((l) => ({ ...l })),
    directCostLines: [{ amountBase: -3, distributionMethod: 'BY_VALUE' }],
  })
  assert.equal(full.floors.length, 1)
})

test('T2b: a gross exactly 0 is NOT a floor event, and the per-line floor is independent across lines', () => {
  const core = allocateLandedCost([line('A', 1, 3), line('B', 1, 1000)], [cost(-3, 'BY_QUANTITY')])
  // BY_QUANTITY: -1.5 each. A: 3 - 1.5 = 1.5 (no floor); B 998.5.
  assert.deepEqual(asNumbers(core.grossUnitCostBaseByLine), { A: 1.5, B: 998.5 })
  const exact = allocateLandedCost([line('A', 1, 3)], [cost(-3)])
  console.log(`T2b PRECONDITION: gross exactly zero without a floor event: gross=${exact.grossUnitCostBaseByLine.get('A')}, floors=${exact.floors.length}`)
  assert.equal(exact.grossUnitCostBaseByLine.get('A')?.toString(), '0')
  assert.equal(exact.floors.length, 0)
  const mixed = allocateLandedCost([line('A', 1, 1), line('B', 1, 100)], [cost(-3, 'BY_QUANTITY')])
  // -1.5 each: A floors (1 - 1.5 = -0.5), B does not (98.5).
  assert.deepEqual(asNumbers(mixed.grossUnitCostBaseByLine), { A: 0, B: 98.5 })
  assert.deepEqual(mixed.floors.map((f) => f.lineId), ['A'])
})

test('T7: a negative value that rounds to zero never leaves as a signed zero (-0)', () => {
  // unit 0, qty 1000, amount -0.0001: -1e-7 per unit, which rounds to -0 at 6dp.
  const rawRounded = D(0).add(D('-0.0001').div(1000)).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP)
  console.log(`T7 PRECONDITION: the rounded pre-floor value is a signed zero: isZero=${rawRounded.isZero()}, isNegative=${rawRounded.isNegative()}`)
  assert.equal(rawRounded.isZero() && rawRounded.isNegative(), true, 'the fixture must actually produce -0 or this proves nothing')
  const core = allocateLandedCost([line('A', 1000, 0)], [cost('-0.0001')])
  const gross = core.grossUnitCostBaseByLine.get('A')!
  assert.equal(Object.is(gross.toNumber(), 0), true, 'toNumber() of the floored cost must be +0, not -0')
  assert.equal(gross.isNegative(), false)
  assert.equal(core.floors.length, 0, 'a value that rounds to zero is not a floor event')
  // The exported floor itself, on a literal signed zero.
  assert.equal(Object.is(floorUnitCostAtZero(rawRounded).toNumber(), 0), true)
  assert.equal(floorUnitCostAtZero(D(0).sub(D(1))).toString(), '0')
  // And a real credit landing on exactly zero.
  const credit = allocateLandedCost([line('A', 1, 1)], [cost(-1)])
  assert.equal(Object.is(credit.grossUnitCostBaseByLine.get('A')!.toNumber(), 0), true)
})

// ─── T10: exact conservation, and the rounding order the floor must respect ─────────────────────────────

test('T10: conservation is EXACT — floored stock value equals the unfloored value plus the residue, in total', () => {
  // Three lines, mixed sign cost lines, ONE floored. BY_QUANTITY credit -9 over qty 1/1/2 = -2.25 per unit...
  const lines = [line('L1', 1, 1), line('L2', 3, 10), line('L3', 200, 0)]
  const costLines = [cost(-9, 'BY_QUANTITY', 0, 'c1'), cost(5, 'BY_VALUE', 1, 'c2'), cost('-0.0001', 'BY_QUANTITY', 1, 'c3')]
  const core = allocateLandedCost(lines, costLines)
  const qtyById = new Map(lines.map((l) => [l.id, new Prisma.Decimal(l.qty)]))
  let flooredValue = D(0)
  let unflooredValue = D(0)
  for (const l of lines) {
    const gross = core.grossUnitCostBaseByLine.get(l.id)!
    const floor = core.floors.find((f) => f.lineId === l.id)
    flooredValue = flooredValue.add(gross.mul(qtyById.get(l.id)!))
    unflooredValue = unflooredValue.add((floor ? floor.unflooredGrossUnitCostBase : gross).mul(qtyById.get(l.id)!))
  }
  const residue = core.floors.reduce((sum, f) => sum.add(unabsorbedBaseForQty(f.unflooredGrossUnitCostBase, f.qty)), D(0))
  console.log(`T10 PRECONDITION: floors=${core.floors.length} (${core.floors.map((f) => `${f.lineId}:${f.unflooredGrossUnitCostBase}`).join(',')}), flooredValue=${flooredValue}, residue=${residue}, unflooredValue=${unflooredValue}`)
  assert.ok(core.floors.length >= 1, 'the fixture must floor at least one line')
  // The stock value laid is the UNFLOORED value plus the residue the floor left out: a floored line is held at
  // 0 where it would have been negative, so stock is worth MORE than the unfloored sum, by exactly the residue.
  assert.equal(flooredValue.eq(unflooredValue.add(residue)), true, 'Decimal equality, no epsilon')
  assert.equal(residue.gt(0), true)
})

test('T10b: the floor is applied AFTER rounding — a -0.0000005 tie rounds away from zero to -0.000001 and IS a floor event', () => {
  // unit 0, qty 200, amount -0.0001 = -5e-7 per unit, exactly on the HALF_UP tie: rounds to -0.000001 (away
  // from zero). Floored BEFORE rounding it would be zero and report nothing.
  const core = allocateLandedCost([line('T', 200, 0)], [cost('-0.0001')])
  console.log(`T10b PRECONDITION: floors=${core.floors.length}, unfloored=${core.floors[0]?.unflooredGrossUnitCostBase}, residue over 200 units=${core.floors[0] ? unabsorbedBaseForQty(core.floors[0].unflooredGrossUnitCostBase, core.floors[0].qty) : 'n/a'}`)
  assert.equal(core.floors.length, 1)
  assert.equal(core.floors[0].unflooredGrossUnitCostBase.toString(), '-0.000001')
  assert.equal(unabsorbedBaseForQty(core.floors[0].unflooredGrossUnitCostBase, core.floors[0].qty).toString(), '0.0002')
  assert.equal(core.grossUnitCostBaseByLine.get('T')?.toString(), '0')
})

// ─── Determinism: the order the shares are summed in must not depend on the read ────────────────────────

function permutationsOf<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items]
  return items.flatMap((item, index) => permutationsOf([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]))
}

test('T6: the allocation is INVARIANT to cost-line order and to id renumbering (property test over order-sensitive fixtures)', () => {
  // Fixtures found by search on which the ORDER the shares are summed in changes the 6dp answer: Decimal division
  // and addition round to 20 significant digits, so (a+b)+c and (c+b)+a can land on opposite sides of a 6dp
  // HALF_UP boundary. Ids are renumbered whenever a freight order's lines are re-saved and a read has no ORDER BY,
  // so an allocation that depended on either would let a save that changed nothing move a stored unit cost.
  const fixtures: Array<{ name: string; lines: LandedAllocationLine[]; costs: Array<[string, string, 0 | 1]> }> = [
    {
      name: 'F1 BY_QUANTITY x3',
      lines: [
        { id: 'L0', qty: 25, unitCostBase: 3.01, totalBase: 75.25, weight: null },
        { id: 'L1', qty: 6, unitCostBase: 19.58, totalBase: 117.48, weight: null },
        { id: 'L2', qty: 8, unitCostBase: 6.46, totalBase: 51.68, weight: null },
        { id: 'L3', qty: 17, unitCostBase: 10.74, totalBase: 182.58, weight: null },
      ],
      costs: [['89401.8989', 'BY_QUANTITY', 0], ['-27040.1416', 'BY_QUANTITY', 0], ['18605.9624', 'BY_QUANTITY', 0]],
    },
    {
      name: 'F1b the same lines split across the direct and linked sources',
      lines: [
        { id: 'L0', qty: 25, unitCostBase: 3.01, totalBase: 75.25, weight: null },
        { id: 'L1', qty: 6, unitCostBase: 19.58, totalBase: 117.48, weight: null },
        { id: 'L2', qty: 8, unitCostBase: 6.46, totalBase: 51.68, weight: null },
        { id: 'L3', qty: 17, unitCostBase: 10.74, totalBase: 182.58, weight: null },
      ],
      costs: [['89401.8989', 'BY_QUANTITY', 0], ['-27040.1416', 'BY_QUANTITY', 1], ['18605.9624', 'BY_QUANTITY', 1]],
    },
    {
      name: 'F2 EQUAL_SPLIT + BY_QUANTITY',
      lines: [
        { id: 'L0', qty: 30, unitCostBase: 10.98, totalBase: 329.4, weight: null },
        { id: 'L1', qty: 12, unitCostBase: 8.79, totalBase: 105.48, weight: null },
        { id: 'L2', qty: 12, unitCostBase: 2.06, totalBase: 24.72, weight: null },
        { id: 'L3', qty: 31, unitCostBase: 0.83, totalBase: 25.73, weight: null },
      ],
      costs: [['79079.8278', 'EQUAL_SPLIT', 0], ['-66285.3417', 'BY_QUANTITY', 0], ['-30302.1575', 'BY_QUANTITY', 0]],
    },
    {
      name: 'F3 EQUAL_SPLIT x3',
      lines: [
        { id: 'L0', qty: 39, unitCostBase: 19.78, totalBase: 771.42, weight: null },
        { id: 'L1', qty: 8, unitCostBase: 5, totalBase: 40, weight: null },
        { id: 'L2', qty: 21, unitCostBase: 10.08, totalBase: 211.68, weight: null },
      ],
      costs: [['87040.6095', 'EQUAL_SPLIT', 0], ['-74338.2949', 'EQUAL_SPLIT', 0], ['-26049.4607', 'EQUAL_SPLIT', 0]],
    },
  ]
  const render = (a: ReturnType<typeof allocateLandedCost>) => JSON.stringify([
    [...a.grossUnitCostBaseByLine].sort(([x], [y]) => (x < y ? -1 : 1)).map(([id, v]) => [id, v.toString()]),
    [...a.landedAmountByLine].sort(([x], [y]) => (x < y ? -1 : 1)).map(([id, v]) => [id, v.toString()]),
    a.floors.map((f) => [f.lineId, f.unflooredGrossUnitCostBase.toString()]),
  ])
  // The oracle: sum the shares by hand in a stated order and report every line's 6dp cost.
  const byHand = (fixture: (typeof fixtures)[number], order: Array<[string, string, 0 | 1]>) => fixture.lines.map((line) => {
    let landed = new Prisma.Decimal(0)
    for (const [amount, method] of order) {
      const base = (l: LandedAllocationLine) => (method === 'BY_QUANTITY' ? new Prisma.Decimal(l.qty) : new Prisma.Decimal(1))
      const total = fixture.lines.reduce((sum, l) => sum.add(base(l)), new Prisma.Decimal(0))
      landed = landed.add(new Prisma.Decimal(amount).mul(base(line)).div(total))
    }
    return new Prisma.Decimal(line.unitCostBase).add(landed.div(line.qty)).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP).toString()
  }).join()
  let sensitive = 0
  let compared = 0
  for (const fixture of fixtures) {
    const make = (order: number[], ids: string[]) => allocateLandedCost(
      [...fixture.lines].reverse(),
      order.map((i, position) => ({ id: ids[position], amountBase: fixture.costs[i][0], distributionMethod: fixture.costs[i][1], sourceRank: fixture.costs[i][2] })),
    )
    const baseline = make([0, 1, 2], ['a', 'b', 'c'])
    // PRECONDITION: summing the same shares in the opposite order BY HAND gives a different answer for this fixture
    // (so an order-dependent allocation would be observable here).
    const forward = byHand(fixture, fixture.costs)
    const backward = byHand(fixture, [...fixture.costs].reverse())
    if (forward !== backward) sensitive += 1
    for (const order of permutationsOf([0, 1, 2])) {
      for (const ids of permutationsOf(['a', 'b', 'c'])) {
        assert.equal(render(make(order, ids)), render(baseline), `${fixture.name}: cost order ${order.join('')} / ids ${ids.join('')} changed the allocation`)
        compared += 1
      }
    }
  }
  console.log(`T6 PRECONDITION: fixtures: ${fixtures.length}, order-sensitive by hand: ${sensitive}, permutation x renumbering combinations compared: ${compared}`)
  assert.equal(sensitive >= 3, true, 'at least three fixtures must be genuinely order-sensitive or this proves nothing')
})

// ─── Warnings ────────────────────────────────────────────────────────────────────────────────────────────

test('T5: a BY_WEIGHT credit falling back to an equal split is reported with its source, and a ZERO line is not', () => {
  const lines = [line('A', 1, 10, 0), line('B', 1, 10, 0)]
  const credit = allocateLandedCost(lines, [cost(-2, 'BY_WEIGHT', 0, 'x'), cost(3, 'BY_WEIGHT', 1, 'y'), cost(0, 'BY_WEIGHT', 1, 'z')])
  console.log(`T5 PRECONDITION: events=${JSON.stringify(credit.events)}`)
  assert.deepEqual(credit.events, [
    { kind: 'weight_fallback', sourceRank: 0, costLineId: 'x' },
    { kind: 'weight_fallback', sourceRank: 1, costLineId: 'y' },
  ])
})

// ─── T12: the operator text ──────────────────────────────────────────────────────────────────────────────

/**
 * A local, deliberately small port of the ledger-standing "unconditional instruction" checker. The shared
 * helper (tests/helpers/unconditional-instruction.ts) is not on development yet; this one flags a clause
 * that tells the operator to post/reverse/credit/void something, or states a negative ledger history
 * ("nothing was posted"), neither of which a landed-cost floor warning has any evidence for.
 */
const MONEY_WORD = /\b(reverse|reversed|reversal|credit|void|re-?post|repost)\b/i
const POST_VERB = /(?:^|[:,(]\s*|\b(?:then|and|or|to|must|should|can|may|just|now|please|you)\s+)(?:post|hand-post|raise|record|enter|book|remove|delete|adjust|write[- ]off|clear|re-?send|resend|retry)\b/i
const HISTORY_CLAIM = /\b(nothing (was|has been) (sent|posted|debited|made)|(was|were|is|are|has been|have been) not (sent|posted)|never (sent|posted))\b/i

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+|\s+[—–]\s+|,\s+so\s+(?:then\s+)?/).map((s) => s.trim()).filter(Boolean)
}
function unconditionalInstructions(text: string): string[] {
  return sentencesOf(text).filter((sentence) => MONEY_WORD.test(sentence) || POST_VERB.test(sentence) || HISTORY_CLAIM.test(sentence))
}

test('T12: the operator text is facts only, names the residue and the line, and passes the instruction checker', () => {
  const entries: FlooredLandedCreditEntry[] = [
    { label: 'SKU-A', unabsorbedBase: D('6'), unflooredGrossUnitCostBase: D('-6') },
    { label: 'SKU-B', unabsorbedBase: D('0.0002'), unflooredGrossUnitCostBase: D('-0.000001') },
  ]
  const text = describeFlooredLandedCredit({ context: 'PO PO-1 receipt', entries })
  console.log(`T12 PRECONDITION: text under test: ${text}`)
  assert.match(text, /6\.00/, 'names the total residue rounded to 2dp')
  assert.match(text, /SKU-A: 6\.00/)
  assert.match(text, /SKU-B: 0\.00/)
  assert.equal(totalUnabsorbedBase(entries).toString(), '6.0002')
  assert.match(text, /IMS queued no journal for that amount/)
  assert.deepEqual(unconditionalInstructions(text), [], 'a facts-only sentence has no instruction and no ledger-history claim')
  // The PREVIEW tense claims nothing happened: no past-tense "valued" / "queued" for units not yet received.
  const pending = describeFlooredLandedCredit({ context: 'PO PO-1', entries, tense: 'pending' })
  console.log(`T12 PRECONDITION: pending-tense text: ${pending}`)
  assert.match(pending, /will value those units at 0\.00/)
  assert.match(pending, /will queue no journal/)
  assert.doesNotMatch(pending, /\b(valued|queued|was larger)\b/)
  assert.deepEqual(unconditionalInstructions(pending), [])
  // The checker CAN fail: it flags both an instruction and a history claim.
  const controls = [
    'Post the difference to the inventory revaluation account.',
    'Reverse the receipt journal and credit the supplier.',
    'Nothing was posted for this amount.',
  ]
  for (const control of controls) {
    assert.equal(unconditionalInstructions(control).length > 0, true, `negative control not flagged: ${control}`)
  }
})

// ─── Census: one core, no second loop, no sign filter, one sentence ─────────────────────────────────────

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'generated' || name === '.next') continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}
const SOURCES = [...sourceFiles('app'), ...sourceFiles('lib')]
const read = (file: string) => readFileSync(file, 'utf8')
function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length
}

test('census: the distribution arithmetic exists ONLY in the allocation module, and no cost line is filtered by sign', () => {
  const allocation = 'lib/domain/purchasing/landed-cost-allocation.ts'
  const callers = SOURCES.filter((file) => count(read(file), /\bcomputeDistributionBase\(/g) > 0)
  console.log(`census PRECONDITION: files calling computeDistributionBase( : ${callers.join(', ')} (of ${SOURCES.length} source files scanned)`)
  assert.deepEqual(callers, [allocation])

  // The sign filter that made receipt and revaluation disagree. Universal: any file, any spelling of it.
  const SIGN_FILTER = /amountBase[^\n]{0,40}\.(?:lte|lt)\(0\)\)?\s*(?:continue|return)/
  assert.equal(SIGN_FILTER.test('if (amountBase.lte(0)) continue'), true, 'the pattern must be able to match the removed filter')
  // Scoped to the readers of PURCHASE-ORDER landed cost. Manufacturing cost lines are a separate path with
  // their own rule (it rejects non-positive lines at its boundary) and are out of scope here.
  const PURCHASE_LANDED_COST_READERS = SOURCES.filter((file) => (
    file.startsWith('lib/domain/purchasing/')
    || file.startsWith('lib/domain/wms/')
    || file.startsWith('lib/connectors/mintsoft/')
    || file === 'app/actions/purchase-orders.ts'
  ))
  const offenders = PURCHASE_LANDED_COST_READERS.filter((file) => SIGN_FILTER.test(read(file)))
  console.log(`census: sign-filter matches across ${PURCHASE_LANDED_COST_READERS.length} purchase-order landed-cost source files: ${offenders.length}`)
  assert.deepEqual(offenders, [])

  // The old per-unit landed arithmetic, written out by hand, anywhere outside the core.
  const handRolled = SOURCES.filter((file) => file !== allocation && /landedPerUnit|landedByLine\.set\(/.test(read(file)))
  assert.deepEqual(handRolled, [])
})

test('census: every writer of a PO-derived layer cost takes it from the one allocation (exact call counts)', () => {
  const expected: Array<[string, RegExp, number]> = [
    // The PO detail preview AND the manual receipt.
    ['app/actions/purchase-orders.ts', /\bcomputeLandedCostForPendingLines\(/g, 2],
    ['lib/domain/wms/booked-in-service.ts', /\bcomputeLandedCostForPendingLines\(/g, 1],
    ['lib/connectors/mintsoft/sync/stock-sync.ts', /\bcomputeLandedCostForPendingLines\(/g, 1],
    // The wrapper plus both revaluation paths.
    ['lib/domain/purchasing/landed-cost-service.ts', /\ballocateLandedCost\(/g, 3],
  ]
  for (const [file, pattern, want] of expected) {
    const got = count(read(file), pattern)
    console.log(`census: ${file} calls ${pattern.source} x${got} (expected ${want})`)
    assert.equal(got, want, `${file}`)
  }
  // And nobody else computes it: the six call sites above are the only importers of either entry point.
  const importers = SOURCES.filter((file) => /\b(computeLandedCostForPendingLines|computeGrossUnitCostBaseByLine|allocateLandedCost)\(/.test(read(file)))
    .filter((file) => !file.endsWith('landed-cost-allocation.ts'))
  assert.deepEqual(importers.sort(), [
    'app/actions/purchase-orders.ts',
    'lib/connectors/mintsoft/sync/stock-sync.ts',
    'lib/domain/purchasing/landed-cost-service.ts',
    'lib/domain/wms/booked-in-service.ts',
  ])
})

test('census: the operator sentence is written in ONE place', () => {
  const builder = 'lib/domain/purchasing/landed-cost-floor-text.ts'
  const PHRASE = /valued those units at|will value those units at/
  const holders = SOURCES.filter((file) => PHRASE.test(read(file)))
  console.log(`census: files containing the floor sentence: ${holders.join(', ')}`)
  assert.deepEqual(holders, [builder])
  // Every surface reaches it through the builder.
  for (const file of [
    'lib/domain/purchasing/landed-cost-service.ts',
    'lib/domain/purchasing/landed-cost-floor-activity.ts',
    'app/actions/purchase-orders.ts',
  ]) {
    assert.ok(/describeFlooredLandedCredit\(|logFlooredLandedCredit\(/.test(read(file)), `${file} does not use the shared builder`)
  }
})

// ─── Docs: no stale claim survives beside the new behaviour (ABSENCE checks, not "includes") ───────────


test('docs: the operator guides no longer say a freight credit is refused or drives cost negative, and the symlink farm resolves to the edited files', () => {
  const STALE: Array<[string, RegExp]> = [
    ['help-docs/purchasing.md', /A credit that would push an already-journaled shipment's cost below zero is refused/],
    ['help-docs/purchasing.md', /the cost lines are saved but the recalculation is refused/],
    ['help-docs/xero-sync.md', /unit cost can go below zero when a landed-cost recalculation spreads a credit/],
    ['help-docs/xero-sync.md', /usually by removing or correcting the credit freight cost line/],
    ['lib/domain/inventory/transfer-cost-layer-recreation.ts', /The input IS reachable, so refusing/],
    ['docs/todo/negative-basis-cost-layers-decision.md', /\*\*Status:\*\* DECISION NOT TAKEN/],
  ]
  // The patterns CAN match: each is shown to match a copy of the stale sentence it targets.
  assert.equal(STALE[0][1].test("- **A credit that would push an already-journaled shipment's cost below zero is refused.**"), true)
  let found = 0
  for (const [file, pattern] of STALE) {
    const hit = pattern.test(read(file))
    console.log(`docs: stale claim ${pattern.source.slice(0, 50)}... in ${file}: ${hit ? 'PRESENT' : 'absent'}`)
    if (hit) found += 1
  }
  assert.equal(found, 0, 'a stale claim survives beside the new text')

  // The new behaviour is stated once, in the guide the symlink farm serves under docs/ as well.
  const guide = read('help-docs/purchasing.md')
  assert.match(guide, /A unit is never valued below zero/)
  assert.match(guide, /landed_cost_credit_floored/)
  for (const name of ['purchasing.md', 'glossary.md', 'xero-sync.md']) {
    const link = `docs/${name}`
    const isLink = lstatSync(link).isSymbolicLink()
    console.log(`docs: ${link} is a symlink: ${isLink}${isLink ? ` -> ${readlinkSync(link)}` : ''}`)
    assert.equal(isLink, true, `${link} must stay a symlink to help-docs (the edit lands in the target)`)
    assert.equal(readlinkSync(link), `../help-docs/${name}`)
  }
})
