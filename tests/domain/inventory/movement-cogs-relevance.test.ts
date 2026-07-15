import assert from 'node:assert/strict'
import test from 'node:test'
import { StockMovementType } from '../../../app/generated/prisma/client.ts'
import {
  LAYER_CONSUMING_MOVEMENT_TYPES_WITHOUT_COGS_ENTRIES,
  MOVEMENT_COGS_RELEVANCE,
  REVALUATION_EXCLUDED_MOVEMENT_TYPES,
  REVALUATION_KNOWN_GAP_MOVEMENT_TYPES,
} from '../../../lib/domain/inventory/movement-cogs-relevance.ts'
import { REVALUATION_EXCLUSION_QUERY_MOVEMENT_TYPES } from '../../../lib/cost-layers.ts'

const ALL_MOVEMENT_TYPES = Object.values(StockMovementType) as StockMovementType[]

test('every StockMovementType is classified against customer COGS (6oyu.7)', () => {
  // The registry is typed Record<StockMovementType, ...>, so an unclassified new
  // enum value is already a compile error. This asserts it at runtime too, which
  // is what catches a value added to the DB enum while the generated client and
  // the registry drift apart.
  const missing = ALL_MOVEMENT_TYPES.filter((type) => !(type in MOVEMENT_COGS_RELEVANCE))
  assert.deepEqual(missing, [], `unclassified movement types: ${missing.join(', ')}`)

  const extra = Object.keys(MOVEMENT_COGS_RELEVANCE).filter(
    (type) => !ALL_MOVEMENT_TYPES.includes(type as StockMovementType),
  )
  assert.deepEqual(extra, [], `registry classifies non-existent movement types: ${extra.join(', ')}`)
})

test('every revaluation-EXCLUDE movement type has an exclusion query, and vice versa (6oyu.7)', () => {
  // The drift guard this issue exists for. Classifying a movement type as EXCLUDE
  // is a claim that revaluation subtracts its units; if no query in cost-layers.ts
  // actually does, revaluation posts spurious COGS for them. Keep the two in lockstep.
  assert.deepEqual(
    [...REVALUATION_EXCLUSION_QUERY_MOVEMENT_TYPES].sort(),
    REVALUATION_EXCLUDED_MOVEMENT_TYPES,
    'REVALUATION_EXCLUDED_MOVEMENT_TYPES (registry) and the exclusion queries in cost-layers.ts disagree — ' +
    'a movement type classified EXCLUDE has no query subtracting it, or a query subtracts a type not classified EXCLUDE.',
  )
})

test('registry entries are internally consistent (6oyu.7)', () => {
  for (const type of ALL_MOVEMENT_TYPES) {
    const entry = MOVEMENT_COGS_RELEVANCE[type]

    // A type that never consumes layers can never reach netConsumedQty, so any
    // treatment other than NOT_APPLICABLE would be meaningless.
    if (entry.relevance === 'NEVER_CONSUMES') {
      assert.equal(entry.treatment, 'NOT_APPLICABLE', `${type}: NEVER_CONSUMES must be NOT_APPLICABLE`)
      assert.equal(entry.writesCogsEntries, false, `${type}: NEVER_CONSUMES cannot write cogs_entries`)
    }

    // Excluding units that ARE customer COGS would under-post COGS.
    if (entry.treatment === 'EXCLUDE') {
      assert.equal(entry.relevance, 'NOT_CUSTOMER_COGS', `${type}: only non-customer-COGS units may be excluded`)
      assert.equal(entry.writesCogsEntries, true, `${type}: the exclusion queries are cogsEntry-based, so an excluded type must write them`)
    }

    // INCLUDE_IN_COGS is only defensible for units that really are a sale.
    if (entry.treatment === 'INCLUDE_IN_COGS') {
      assert.equal(entry.relevance, 'CUSTOMER_COGS', `${type}: only customer-COGS units may be included`)
    }

    // A known gap without a tracking issue is just an undocumented bug.
    if (entry.treatment === 'KNOWN_GAP') {
      assert.match(
        entry.note,
        /onetwo3d-ims-\w+|o3d-\w+/,
        `${type}: a KNOWN_GAP must reference the bd issue tracking its fix`,
      )
    }

    assert.ok(entry.note.trim().length > 0, `${type}: classification must carry a rationale`)
  }
})

test('the cogsEntry-based exclusion blind spot is enumerated (6oyu.7 / 6oyu.19)', () => {
  // The exclusion queries are cogsEntry-based while consumedQty is layer-derived,
  // so a type that consumes layers without writing cogs_entries is structurally
  // invisible to them — that is exactly how the TRANSFER_OUT double-count
  // (6oyu.19) survived. Pin the known members so a NEW one is a deliberate choice.
  assert.deepEqual(LAYER_CONSUMING_MOVEMENT_TYPES_WITHOUT_COGS_ENTRIES, ['TRANSFER_OUT'])

  // No cogsEntry-less type may claim EXCLUDE — a cogsEntry query cannot subtract it.
  for (const type of LAYER_CONSUMING_MOVEMENT_TYPES_WITHOUT_COGS_ENTRIES) {
    assert.notEqual(MOVEMENT_COGS_RELEVANCE[type].treatment, 'EXCLUDE')
  }
})

test('known revaluation gaps are exactly the ones currently tracked (6oyu.7)', () => {
  // Fails when a gap is fixed (drop it here + flip its treatment) or a new one is
  // classified — either way the change should be conscious.
  assert.deepEqual(REVALUATION_KNOWN_GAP_MOVEMENT_TYPES, ['ADJUSTMENT', 'TRANSFER_OUT'])
})
