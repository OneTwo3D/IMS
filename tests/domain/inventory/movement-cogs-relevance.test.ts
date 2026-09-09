import assert from 'node:assert/strict'
import test from 'node:test'
import { StockMovementType, StockTransferStatus } from '../../../app/generated/prisma/client.ts'
import {
  COGS_ENTRY_EXCLUDED_MOVEMENT_TYPES,
  LAYER_CONSUMING_MOVEMENT_TYPES_WITHOUT_COGS_ENTRIES,
  MOVEMENT_COGS_RELEVANCE,
  REVALUATION_ACCEPTED_TRADEOFF_MOVEMENT_TYPES,
  REVALUATION_EXCLUDED_MOVEMENT_TYPES,
  REVALUATION_KNOWN_GAP_MOVEMENT_TYPES,
  STOCK_TRANSFER_SOURCE_LAYER_CONSUMPTION,
  TRANSFER_SNAPSHOT_EXCLUDED_MOVEMENT_TYPES,
  TRANSFER_STATUSES_WITH_OUTSTANDING_SOURCE_CONSUMPTION,
  TRANSFER_STATUSES_WITH_NO_COMPLETION_PATH,
} from '../../../lib/domain/inventory/movement-cogs-relevance.ts'
import { STOCK_TRANSFER_TRANSITIONS } from '../../../lib/domain/workflows/stock-transfer-state.ts'
import { REVALUATION_EXCLUSION_QUERY_MOVEMENT_TYPES } from '../../../lib/cost-layers.ts'

const ALL_MOVEMENT_TYPES = Object.values(StockMovementType) as StockMovementType[]
const ALL_TRANSFER_STATUSES = Object.values(StockTransferStatus) as StockTransferStatus[]

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
      assert.ok(entry.exclusionSource, `${type}: an excluded type must declare where its quantity is read from`)
    }

    // The 6oyu.19 trap: a cogsEntry query cannot see a type that writes none.
    if (entry.exclusionSource === 'COGS_ENTRY') {
      assert.equal(entry.writesCogsEntries, true, `${type}: cannot be excluded via cogs_entries — it writes none`)
    }

    // exclusionSource on a non-excluded type is a contradiction.
    if (entry.treatment !== 'EXCLUDE') {
      assert.equal(entry.exclusionSource, undefined, `${type}: only an EXCLUDE'd type may declare an exclusionSource`)
    }

    // INCLUDE_IN_COGS is only defensible for units that really are a sale.
    // Anything else counted in COGS must say so via ACCEPTED_TRADEOFF, so the
    // divergence cannot hide behind a plain "include".
    if (entry.treatment === 'INCLUDE_IN_COGS') {
      assert.equal(entry.relevance, 'CUSTOMER_COGS', `${type}: only customer-COGS units may be plainly included`)
    }

    // The inverse: a trade-off is only a trade-off if it diverges from the truth.
    if (entry.treatment === 'ACCEPTED_TRADEOFF') {
      assert.equal(entry.relevance, 'NOT_CUSTOMER_COGS', `${type}: customer-COGS units in COGS is not a trade-off, it is just correct`)
    }

    // An undocumented gap is just a bug; an uncited trade-off is indistinguishable
    // from one. Both must name the decision/issue they rest on.
    if (entry.treatment === 'KNOWN_GAP' || entry.treatment === 'ACCEPTED_TRADEOFF') {
      assert.match(
        entry.note,
        /onetwo3d-ims-\w+|o3d-\w+/,
        `${type}: a ${entry.treatment} must reference the bd issue it rests on`,
      )
    }

    assert.ok(entry.note.trim().length > 0, `${type}: classification must carry a rationale`)
  }
})

test('the cogsEntry-based exclusion blind spot is enumerated (6oyu.7 / 6oyu.19)', () => {
  // consumedQty is layer-derived, so a type that consumes layers without writing
  // cogs_entries is structurally invisible to a cogsEntry query — exactly how the
  // TRANSFER_OUT double-count (6oyu.19) survived every earlier audit. Pin the
  // known members so a NEW one is a deliberate choice.
  assert.deepEqual(LAYER_CONSUMING_MOVEMENT_TYPES_WITHOUT_COGS_ENTRIES, ['TRANSFER_OUT'])

  // Each such type must be excluded from a NON-cogsEntry source, never left to a
  // cogsEntry query (which would silently subtract nothing) and never left
  // INCLUDE_IN_COGS (which is the bug itself).
  for (const type of LAYER_CONSUMING_MOVEMENT_TYPES_WITHOUT_COGS_ENTRIES) {
    const entry = MOVEMENT_COGS_RELEVANCE[type]
    assert.notEqual(entry.exclusionSource, 'COGS_ENTRY', `${type}: writes no cogs_entries, so a cogsEntry query would subtract nothing`)
    assert.notEqual(entry.treatment, 'INCLUDE_IN_COGS', `${type}: is not customer COGS`)
  }
})

test('each exclusion source covers exactly the types it can actually see (6oyu.19)', () => {
  assert.deepEqual(COGS_ENTRY_EXCLUDED_MOVEMENT_TYPES, ['PRODUCTION_OUT', 'PURCHASE_REVERSAL'])
  assert.deepEqual(TRANSFER_SNAPSHOT_EXCLUDED_MOVEMENT_TYPES, ['TRANSFER_OUT'])
})

test('no revaluation gaps remain unresolved (6oyu.7)', () => {
  // TRANSFER_OUT left this list when 6oyu.19 was fixed; ADJUSTMENT left it when
  // 6oyu.20 was decided as an accepted trade-off. A new entry here means a newly
  // discovered defect — which should be a conscious, tracked addition.
  assert.deepEqual(REVALUATION_KNOWN_GAP_MOVEMENT_TYPES, [])
})

test('accepted trade-offs are exactly the ones decided (6oyu.20)', () => {
  // ADJUSTMENT: its reason account is unrecoverable at revaluation time
  // (StockMovement stores no reasonId — only a free-text note), and excluding it
  // without routing would strand the delta in transit and understate expense.
  // Counting it in COGS keeps transit draining and the P&L total right, matching
  // the scjz.10 supplier-return decision. Deliberate, not a bug.
  assert.deepEqual(REVALUATION_ACCEPTED_TRADEOFF_MOVEMENT_TYPES, ['ADJUSTMENT'])

  // A trade-off must not also be excluded — that would be silently subtracting
  // the very units the decision says to keep.
  for (const type of REVALUATION_ACCEPTED_TRADEOFF_MOVEMENT_TYPES) {
    assert.ok(!REVALUATION_EXCLUDED_MOVEMENT_TYPES.includes(type), `${type}: accepted into COGS, so it must not be excluded`)
  }
})

test('every StockTransferStatus is classified for source-layer consumption (6oyu.19)', () => {
  // Typed Record<StockTransferStatus, ...>, so an unclassified new status is a
  // compile error. Asserted at runtime too, to catch the generated client and the
  // registry drifting apart after a DB enum change.
  const missing = ALL_TRANSFER_STATUSES.filter((status) => !(status in STOCK_TRANSFER_SOURCE_LAYER_CONSUMPTION))
  assert.deepEqual(missing, [], `unclassified transfer statuses: ${missing.join(', ')}`)

  const extra = Object.keys(STOCK_TRANSFER_SOURCE_LAYER_CONSUMPTION).filter(
    (status) => !ALL_TRANSFER_STATUSES.includes(status as StockTransferStatus),
  )
  assert.deepEqual(extra, [], `registry classifies non-existent transfer statuses: ${extra.join(', ')}`)

  for (const status of ALL_TRANSFER_STATUSES) {
    assert.ok(
      STOCK_TRANSFER_SOURCE_LAYER_CONSUMPTION[status].note.trim().length > 0,
      `${status}: must say WHY, since this list is what the exclusion query filters on`,
    )
  }
})

test('a cancelled dispatch still counts as outstanding source consumption (6oyu.19)', () => {
  // The load-bearing entry. cancelDispatchedTransfer (IN_TRANSIT -> CANCELLED,
  // audit-C5) does NOT un-consume the original source layers: it creates
  // REPLACEMENT layers and links them back with a costLayerSourceLine, so
  // propagateLandedCostToOutputs carries the revaluation delta onto the
  // replacement exactly as it does onto a transfer destination. Leaving CANCELLED
  // out of this list posts the delta as COGS on the original layer as well —
  // 6oyu.19's double count, reached through the cancel path instead of receipt.
  assert.deepEqual(TRANSFER_STATUSES_WITH_OUTSTANDING_SOURCE_CONSUMPTION, ['CANCELLED', 'IN_TRANSIT', 'RECEIVED'])
  assert.equal(STOCK_TRANSFER_SOURCE_LAYER_CONSUMPTION.CANCELLED.consumption, 'OUTSTANDING_PROPAGATABLE')
  // DRAFT never dispatched, so it consumed nothing and wrote no snapshot.
  assert.equal(STOCK_TRANSFER_SOURCE_LAYER_CONSUMPTION.DRAFT.consumption, 'NOT_DISPATCHED')
  assert.ok(!TRANSFER_STATUSES_WITH_OUTSTANDING_SOURCE_CONSUMPTION.includes('DRAFT'))
})

test('IN_TRANSIT is outstanding but has NO completion path, and the registry says so (6oyu.19 / o3d-nrl4)', () => {
  // The whole point of splitting OUTSTANDING. The old single value justified the
  // COGS exclusion by "the delta reaches the units through a replacement or
  // destination layer" — true for RECEIVED and CANCELLED, FALSE for IN_TRANSIT,
  // where no layer exists yet. A revaluation mid-transit subtracts the whole
  // snapshot from COGS, propagates into nothing, and queues no journal: the freight
  // debit stays in transit and inventory stays understated.
  //
  // That is STILL the behaviour — the deferred-reclass machinery that would have
  // closed it was withdrawn on review (o3d-nrl4). What this classification buys is
  // that the registry no longer CLAIMS a completion path it does not have. Both
  // halves are asserted, because either alone misstates the contract: dropping
  // IN_TRANSIT from the exclusion list is 6oyu.19 (spurious COGS), and calling it
  // OUTSTANDING_PROPAGATABLE is the overstatement this split exists to remove.
  assert.equal(
    STOCK_TRANSFER_SOURCE_LAYER_CONSUMPTION.IN_TRANSIT.consumption,
    'OUTSTANDING_AWAITING_DESTINATION_LAYER',
  )
  assert.ok(
    TRANSFER_STATUSES_WITH_OUTSTANDING_SOURCE_CONSUMPTION.includes('IN_TRANSIT'),
    'IN_TRANSIT units were moved, not sold — they must still be excluded from retrospective COGS',
  )
  assert.deepEqual(
    TRANSFER_STATUSES_WITH_NO_COMPLETION_PATH,
    ['IN_TRANSIT'],
    'only IN_TRANSIT has consumed a source layer with no layer anywhere holding the units',
  )

  // The gap list must be a STRICT subset of the exclusion list: a status with no
  // completion path that was ALSO not excluded would post spurious COGS on top.
  for (const status of TRANSFER_STATUSES_WITH_NO_COMPLETION_PATH) {
    assert.ok(
      TRANSFER_STATUSES_WITH_OUTSTANDING_SOURCE_CONSUMPTION.includes(status),
      `${status}: has no completion path and is not excluded from COGS either — the worst of both`,
    )
  }
  assert.ok(
    TRANSFER_STATUSES_WITH_NO_COMPLETION_PATH.length < TRANSFER_STATUSES_WITH_OUTSTANDING_SOURCE_CONSUMPTION.length,
    'precondition: the two lists must differ, or the split is not doing anything',
  )

  // The statuses that stayed OUTSTANDING_PROPAGATABLE must genuinely have a layer to
  // propagate into — asserted by name so that reclassifying one without giving it a
  // destination layer fails here rather than silently stranding value.
  for (const status of TRANSFER_STATUSES_WITH_OUTSTANDING_SOURCE_CONSUMPTION) {
    const consumption = STOCK_TRANSFER_SOURCE_LAYER_CONSUMPTION[status].consumption
    if (TRANSFER_STATUSES_WITH_NO_COMPLETION_PATH.includes(status)) continue
    assert.equal(
      consumption,
      'OUTSTANDING_PROPAGATABLE',
      `${status}: excluded from COGS, so a linked layer MUST already exist to carry the delta`,
    )
  }

  // And the gap is named as a gap in prose, where a reader looks first. A note that
  // stops at "excluded from COGS" is the overstatement all over again.
  assert.match(
    STOCK_TRANSFER_SOURCE_LAYER_CONSUMPTION.IN_TRANSIT.note,
    /KNOWN GAP/,
    'the IN_TRANSIT note must say the delta is stranded, not imply something settles it',
  )
})

test('the transfer-status list is NOT derived from the transfer state machine (6oyu.19)', () => {
  // Why this test exists: STOCK_TRANSFER_TRANSITIONS models the plain cancel path
  // only and states IN_TRANSIT -> RECEIVED as the sole exit from IN_TRANSIT.
  // cancelDispatchedTransfer deliberately performs IN_TRANSIT -> CANCELLED outside
  // the machine. The first fix for 6oyu.19 trusted the map and hard-coded
  // ('IN_TRANSIT', 'RECEIVED'), which is precisely how the cancelled-dispatch case
  // stayed broken. Assert the divergence so that "just derive it from the state
  // machine" is never a tidy-up someone makes.
  assert.deepEqual(STOCK_TRANSFER_TRANSITIONS.IN_TRANSIT, ['RECEIVED'])
  const reachableFromInTransit = new Set<string>(STOCK_TRANSFER_TRANSITIONS.IN_TRANSIT)
  assert.ok(
    !reachableFromInTransit.has('CANCELLED'),
    'if the machine ever models IN_TRANSIT -> CANCELLED, re-read this test before deriving the list from it',
  )
  assert.ok(
    TRANSFER_STATUSES_WITH_OUTSTANDING_SOURCE_CONSUMPTION.includes('CANCELLED'),
    'CANCELLED is only reachable post-dispatch via a path the state machine does not model',
  )
})
