import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  FULFILLMENT_REQUIREMENT_SNAPSHOT_VERSION,
  FulfillmentRequirementSnapshotError,
  captureFulfillmentRequirementSnapshot,
  hasFulfillmentRequirementSnapshot,
  lineFulfillmentLeafProductIds,
  lineFulfillmentRequirementQuantities,
  lineFulfillmentRequirements,
  parseFulfillmentRequirementSnapshot,
  selectCapturableLineIds,
} from '@/lib/products/fulfillment-requirement-snapshot'
import {
  availableQtyFromRequirements,
  scaleFulfillmentRequirements,
} from '@/lib/products/fulfillment-coverage'
import type { FulfillmentGraphNode } from '@/lib/products/kit-fulfillment'

/**
 * o3d-kouj — THE IMMUTABLE PER-LINE FULFILMENT-REQUIREMENT SNAPSHOT.
 *
 * These are the PURE halves: capture, parse, resolve, and the capturable rule. The write path and
 * the "a graph edit no longer changes an in-flight order" behaviour live in
 * tests/domain/sales/allocation-service.test.ts, which has the allocator's transaction double.
 */

type FakeComponent = { componentId: string; qty: string; componentType: 'SIMPLE' | 'KIT' }

function graphOf(
  nodes: Array<{ id: string; type: 'SIMPLE' | 'KIT'; version?: number; components?: FakeComponent[] }>,
): Map<string, FulfillmentGraphNode> {
  return new Map(nodes.map((node) => [node.id, {
    id: node.id,
    type: node.type,
    fulfillmentGraphVersion: node.version ?? 0,
    productComponents: (node.components ?? []).map((component) => ({
      componentId: component.componentId,
      componentSku: component.componentId,
      qty: new Prisma.Decimal(component.qty),
      componentType: component.componentType,
      componentOversellAllowed: false,
    })),
  }]))
}

/** 1 KIT = 2 x A + 1 x B. */
const KIT_2A_1B = graphOf([
  { id: 'kit', type: 'KIT', version: 7, components: [
    { componentId: 'A', qty: '2', componentType: 'SIMPLE' },
    { componentId: 'B', qty: '1', componentType: 'SIMPLE' },
  ] },
  { id: 'A', type: 'SIMPLE' },
  { id: 'B', type: 'SIMPLE' },
])

/** The SAME kit, re-composed to 4 x A + 2 x B — a UNIFORM rescale, and version bumped. */
const KIT_4A_2B = graphOf([
  { id: 'kit', type: 'KIT', version: 8, components: [
    { componentId: 'A', qty: '4', componentType: 'SIMPLE' },
    { componentId: 'B', qty: '2', componentType: 'SIMPLE' },
  ] },
  { id: 'A', type: 'SIMPLE' },
  { id: 'B', type: 'SIMPLE' },
])

function factors(requirements: Array<{ productId: string; factor: Prisma.Decimal }>): Record<string, string> {
  return Object.fromEntries(requirements.map((requirement) => [requirement.productId, requirement.factor.toFixed()]))
}

test('o3d-kouj: a capture records the FLAT leaf set for one unit, with the version of the graph it expanded', () => {
  const snapshot = captureFulfillmentRequirementSnapshot('kit', KIT_2A_1B, new Date('2026-08-20T10:00:00.000Z'))

  assert.equal(snapshot.version, FULFILLMENT_REQUIREMENT_SNAPSHOT_VERSION)
  assert.equal(snapshot.productId, 'kit')
  assert.equal(snapshot.graphVersion, 7, 'the version of the node this expansion came from, not a re-read')
  assert.equal(snapshot.capturedAt, '2026-08-20T10:00:00.000Z')
  assert.deepEqual(snapshot.requirements, [
    { productId: 'A', factor: '2' },
    { productId: 'B', factor: '1' },
  ])
})

test('o3d-kouj: a nested kit is captured FLAT, at the exact scale the multiplication produced', () => {
  const nested = graphOf([
    { id: 'outer', type: 'KIT', components: [{ componentId: 'inner', qty: '0.3333', componentType: 'KIT' }] },
    { id: 'inner', type: 'KIT', components: [{ componentId: 'A', qty: '0.3333', componentType: 'SIMPLE' }] },
    { id: 'A', type: 'SIMPLE' },
  ])

  const snapshot = captureFulfillmentRequirementSnapshot('outer', nested)

  // 0.3333 x 0.3333 = 0.11108889. NOT rounded to the Decimal(12,4) quantity scale: a factor is the
  // multiplicand, not a persisted quantity, and rounding it here would move o3d-i4qd's single
  // rounding one step earlier than "after the whole multiplication".
  assert.deepEqual(snapshot.requirements, [{ productId: 'A', factor: '0.11108889' }])
})

test('o3d-kouj: a non-positive leaf factor is captured and read back VERBATIM, not repaired', () => {
  // `expandFulfillmentRequirementsDecimal` only guards the RECURSION on a non-positive quantity;
  // `addRequirement` is still reached for a non-KIT component, so a zero-qty component really does
  // reach the snapshot. Reproducing the expansion is the contract — inventing a semantic here would
  // make a pinned line and an unpinned line answer the same question differently.
  const zeroComponent = graphOf([
    { id: 'kit', type: 'KIT', components: [
      { componentId: 'A', qty: '2', componentType: 'SIMPLE' },
      { componentId: 'Z', qty: '0', componentType: 'SIMPLE' },
    ] },
    { id: 'A', type: 'SIMPLE' },
    { id: 'Z', type: 'SIMPLE' },
  ])

  const snapshot = captureFulfillmentRequirementSnapshot('kit', zeroComponent)
  assert.deepEqual(snapshot.requirements, [
    { productId: 'A', factor: '2' },
    { productId: 'Z', factor: '0' },
  ])

  const parsed = parseFulfillmentRequirementSnapshot(JSON.parse(JSON.stringify(snapshot)))
  assert.deepEqual(factors(parsed!.requirements), { A: '2', Z: '0' })
})

test('o3d-kouj: an absent snapshot parses to null — that is the ONLY silent answer', () => {
  assert.equal(parseFulfillmentRequirementSnapshot(null), null)
  assert.equal(parseFulfillmentRequirementSnapshot(undefined), null)
})

test('o3d-kouj: a present but unreadable snapshot REFUSES rather than falling back to the current graph', () => {
  const good = JSON.parse(JSON.stringify(captureFulfillmentRequirementSnapshot('kit', KIT_2A_1B)))
  const cases: Array<{ name: string; payload: unknown; reason: RegExp }> = [
    { name: 'not an object', payload: [1, 2, 3], reason: /payload is not an object/ },
    {
      name: 'a version this build does not read',
      payload: { ...good, version: 99 },
      reason: /unsupported snapshot version 99/,
    },
    {
      name: 'no product it was captured for',
      payload: { ...good, productId: '' },
      reason: /missing the product it was captured for/,
    },
    {
      name: 'an empty requirement list',
      payload: { ...good, requirements: [] },
      reason: /records no requirements at all/,
    },
    {
      name: 'a requirement entry that is not an object',
      payload: { ...good, requirements: ['A'] },
      reason: /requirement entry is not an object/,
    },
    {
      name: 'a requirement with no product',
      payload: { ...good, requirements: [{ factor: '2' }] },
      reason: /requirement entry has no product/,
    },
    {
      // THE DEFECT CLASS THIS EXISTS FOR: a snapshot that pins the wrong field name. `toDecimal`
      // maps a missing value to ZERO, and zero is a LEGITIMATE factor here, so a parser that let it
      // coerce would turn a typo into a valid-looking requirement of zero — silently making the
      // line permanently uncoverable instead of loudly unreadable.
      name: 'a requirement whose factor is under the wrong key',
      payload: { ...good, requirements: [{ productId: 'A', qty: '2' }] },
      reason: /requirement for product A has no usable factor \(undefined\)/,
    },
    {
      name: 'a requirement whose factor is not a number at all',
      payload: { ...good, requirements: [{ productId: 'A', factor: { nested: true } }] },
      reason: /requirement for product A has no usable factor/,
    },
    {
      name: 'a requirement whose factor is an unparseable string',
      payload: { ...good, requirements: [{ productId: 'A', factor: 'two' }] },
      reason: /requirement for product A has an unparseable factor/,
    },
  ]

  for (const testCase of cases) {
    assert.throws(
      () => parseFulfillmentRequirementSnapshot(testCase.payload, 'line-1'),
      (error: unknown) => {
        assert.ok(error instanceof FulfillmentRequirementSnapshotError, testCase.name)
        assert.equal(error.lineId, 'line-1', testCase.name)
        assert.match(error.message, testCase.reason, testCase.name)
        assert.match(error.message, /Re-allocate the order/, testCase.name)
        return true
      },
      testCase.name,
    )
  }
})

test('o3d-kouj: a pinned line answers from its PIN, and a re-composed kit cannot change it', () => {
  const line = {
    id: 'line-1',
    productId: 'kit',
    fulfillmentRequirements: JSON.parse(JSON.stringify(captureFulfillmentRequirementSnapshot('kit', KIT_2A_1B))),
  }

  // The catalogue has since been rescaled to 4xA + 2xB. The line still requires what it was
  // allocated from — which is the entire point: a uniform rescale is exactly the edit that every
  // proportionality check is blind to, and the pin makes it irrelevant rather than detectable.
  assert.deepEqual(factors(lineFulfillmentRequirements(line, KIT_4A_2B)), { A: '2', B: '1' })
  assert.equal(hasFulfillmentRequirementSnapshot(line), true)

  // ...and the SAME line without a pin picks up the new recipe, which is the pre-snapshot behaviour.
  assert.deepEqual(
    factors(lineFulfillmentRequirements({ id: 'line-1', productId: 'kit', fulfillmentRequirements: null }, KIT_4A_2B)),
    { A: '4', B: '2' },
  )
  assert.equal(
    hasFulfillmentRequirementSnapshot({ id: 'line-1', productId: 'kit', fulfillmentRequirements: null }),
    false,
  )
})

test('o3d-kouj: a pin captured for a DIFFERENT product is not evidence about this line, and is not used', () => {
  const line = {
    id: 'line-1',
    productId: 'other-kit',
    fulfillmentRequirements: JSON.parse(JSON.stringify(captureFulfillmentRequirementSnapshot('kit', KIT_2A_1B))),
  }
  const otherGraph = graphOf([
    { id: 'other-kit', type: 'KIT', components: [{ componentId: 'C', qty: '5', componentType: 'SIMPLE' }] },
    { id: 'C', type: 'SIMPLE' },
  ])

  assert.deepEqual(factors(lineFulfillmentRequirements(line, otherGraph)), { C: '5' })
  assert.equal(
    hasFulfillmentRequirementSnapshot(line),
    false,
    'a pin for another product must not make this line count as protected, or the CAS would be skipped for it too',
  )
})

test('o3d-kouj: the scaled read multiplies the PINNED factor once, and never re-walks the current graph', () => {
  const line = {
    id: 'line-1',
    productId: 'kit',
    fulfillmentRequirements: JSON.parse(JSON.stringify(captureFulfillmentRequirementSnapshot('kit', KIT_2A_1B))),
  }

  const quantities = lineFulfillmentRequirementQuantities(line, '2.5', KIT_4A_2B)
  assert.deepEqual(
    Object.fromEntries([...quantities].map(([productId, qty]) => [productId, qty.toFixed()])),
    { A: '5', B: '2.5' },
  )

  // Unpinned, the same call expands the CURRENT graph — 2.5 x 4 and 2.5 x 2.
  const unpinned = lineFulfillmentRequirementQuantities({ id: 'line-1', productId: 'kit' }, '2.5', KIT_4A_2B)
  assert.deepEqual(
    Object.fromEntries([...unpinned].map(([productId, qty]) => [productId, qty.toFixed()])),
    { A: '10', B: '5' },
  )
})

test('o3d-kouj: the leaves to lock come from the PIN, including a component the current recipe dropped', () => {
  // The pinned recipe requires B; the current one does not mention it at all. B's stock row is the
  // one this order's reservation sits on, so a lock set derived from the current graph would leave
  // it unlocked.
  const line = {
    id: 'line-1',
    productId: 'kit',
    fulfillmentRequirements: JSON.parse(JSON.stringify(captureFulfillmentRequirementSnapshot('kit', KIT_2A_1B))),
  }
  const withoutB = graphOf([
    { id: 'kit', type: 'KIT', components: [{ componentId: 'A', qty: '2', componentType: 'SIMPLE' }] },
    { id: 'A', type: 'SIMPLE' },
  ])

  assert.deepEqual(lineFulfillmentLeafProductIds([line], withoutB).sort(), ['A', 'B'])
})

test('o3d-kouj: a line may pin only while it holds NOTHING in flight', () => {
  assert.deepEqual(
    selectCapturableLineIds({
      lineIds: ['fresh', 'allocated', 'committed', 'both'],
      lineIdsHoldingAllocations: ['allocated', 'both'],
      lineIdsHoldingCommittedShipments: ['committed', 'both'],
    }),
    ['fresh'],
    'an allocation row OR a committed shipment line freezes the pin; only a line holding neither may re-pin',
  )

  // Dispatch RETAINS the allocation row, which is what makes a shipped line permanently frozen —
  // the property completed-history reporting depends on.
  assert.deepEqual(
    selectCapturableLineIds({
      lineIds: ['shipped'],
      lineIdsHoldingAllocations: ['shipped'],
      lineIdsHoldingCommittedShipments: ['shipped'],
    }),
    [],
  )
})

test('o3d-kouj: a requirement set reachable by two paths is SUMMED, by both the scale and the availability read', () => {
  // A diamond: 1 outer = 2 x mid + 3 x A, and 1 mid = 5 x A. So one outer needs 13 x A.
  const diamond = graphOf([
    { id: 'outer', type: 'KIT', components: [
      { componentId: 'mid', qty: '2', componentType: 'KIT' },
      { componentId: 'A', qty: '3', componentType: 'SIMPLE' },
    ] },
    { id: 'mid', type: 'KIT', components: [{ componentId: 'A', qty: '5', componentType: 'SIMPLE' }] },
    { id: 'A', type: 'SIMPLE' },
  ])
  const snapshot = captureFulfillmentRequirementSnapshot('outer', diamond)
  assert.deepEqual(snapshot.requirements, [{ productId: 'A', factor: '13' }])

  const requirements = [{ productId: 'A', factor: new Prisma.Decimal(13) }]
  assert.equal(scaleFulfillmentRequirements(requirements, 2).get('A')!.toFixed(), '26')

  // 26 units of A in the warehouse is exactly two outers, and 25 is only one. The graph walk
  // (`getFulfillmentAvailableQtyDecimal`) asks each branch independently and would answer
  // min(25/5/2, 25/3) = 2.5 for 25 — authorising an allocation whose own merged rows demand 26.
  const stock = new Map([['A', new Map([['w1', new Prisma.Decimal(25)]])]])
  assert.equal(availableQtyFromRequirements(requirements, 'w1', stock).toFixed(), '1.9230769230769230769')
})
