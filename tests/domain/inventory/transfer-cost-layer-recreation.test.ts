import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { consumeFifoLayers } from '@/lib/cost-layers'
import { openSavepointDepth, withSavepoint } from '@/lib/db/savepoint'
import {
  UncostedBookedQuantityError,
  NegativeCostSnapshotEntryError,
  TransferCostLayerRecreationContextError,
  recreateTransferCostLayersFromSnapshotSlice,
} from '@/lib/domain/inventory/transfer-cost-layer-recreation'

/**
 * 6oyu.19 / Codex rounds 2, 4 and 5. Four paths rebuild cost layers from a transfer's
 * dispatch snapshot; two of them forgot to link the new layer back to the layer it
 * came from, which quietly removed the units from COGS with nowhere for the
 * landed-cost delta to go. These tests cover the fix's parts:
 *
 *  - the LINK is a postcondition of the shared helper (so no caller can forget it),
 *  - the QUANTITY is too (every caller increments stock before calling, so an entry
 *    the helper declines is unlayered stock, not a reportable gap),
 *  - a NEGATIVE-cost entry is REFUSED with nothing created and the enclosing
 *    transaction aborted (round-5 HIGH, o3d-gd2f), and
 *  - a census fails if a fifth path open-codes the sequence again, or if any caller
 *    wraps the call in something that could swallow the refusal.
 *
 * The helper does NOT settle a revaluation that landed while the units were in
 * transit — that machinery was withdrawn from this branch (o3d-nrl4), so there are
 * no settlement tests here. See the contract on
 * STOCK_TRANSFER_SOURCE_LAYER_CONSUMPTION.IN_TRANSIT for what is still open.
 */

/** What Postgres says once a statement in the transaction has failed. */
const ABORTED_TRANSACTION = 'current transaction is aborted, commands ignored until end of transaction block'

type Store = {
  layers: Map<string, { id: string; sourceLines: Array<Record<string, unknown>> }>
  sourceLines: Array<Record<string, unknown>>
  created: Array<Record<string, unknown>>
  /** Every raw statement the helper issued, with its BOUND parameters. */
  rawStatements: Array<{ sql: string; params: unknown[] }>
  /** Mirrors Postgres: once a statement has failed, nothing else may run. */
  aborted: boolean
  /** Ordered log of every operation, so "aborted BEFORE anything was written" is assertable. */
  operations: string[]
}

/**
 * A transaction client that models the ONE Postgres behaviour this fix depends on:
 * a failed statement poisons the transaction, and every later statement — and the
 * COMMIT — fails with 25P02. Without that, a test asserting "the caller cannot
 * swallow the refusal" would be asserting something about a mock that cannot refuse.
 *
 * Verified against a real Postgres 2026-09-10 (scratch database, Prisma 7.8.0 +
 * @prisma/adapter-pg): an ordinary throw swallowed inside `db.$transaction` COMMITS
 * the caller's rows (2 of 2 committed); the same swallow after this abort statement
 * rejects the transaction with 25P02 and commits 0.
 */
function createStore(
  sourceLayerHasProvenance: boolean,
  context: { inTransaction?: boolean } = {},
): { store: Store; tx: unknown } {
  // The helper's entry precondition asks the CLIENT whether it is inside a
  // transaction, so the double has to be able to answer both ways — otherwise the
  // "refuses outside a transaction" test would be asserting something about a mock
  // that cannot say no (Codex round-6 HIGH-2).
  const inTransaction = context.inTransaction ?? true
  const store: Store = {
    layers: new Map(),
    sourceLines: [],
    created: [],
    rawStatements: [],
    aborted: false,
    operations: [],
  }
  store.layers.set('layer-src', {
    id: 'layer-src',
    sourceLines: sourceLayerHasProvenance
      ? [{ sourceProductId: 'prod-parent', sourceCostLayerId: 'layer-grandparent', qty: 10, unitCostBase: 4, totalCostBase: 40 }]
      : [],
  })
  let seq = 0
  const guard = (operation: string) => {
    store.operations.push(operation)
    if (store.aborted) throw new Error(ABORTED_TRANSACTION)
  }
  const tx = {
    /**
     * `SAVEPOINT` is how `isClientInsideTransaction` discriminates: PostgreSQL
     * raises 25P01 for it on an autocommit connection and accepts it inside a
     * transaction block. Modelled faithfully so both answers are reachable.
     */
    $executeRawUnsafe: async (sql: string) => {
      store.operations.push(`$executeRawUnsafe:${sql}`)
      store.rawStatements.push({ sql, params: [] })
      if (/^SAVEPOINT /.test(sql) && !inTransaction) {
        throw new Error('ERROR: SAVEPOINT can only be used in transaction blocks\ncode: 25P01')
      }
      if (store.aborted) throw new Error(ABORTED_TRANSACTION)
      return 0
    },
    // Tagged template, as Prisma's is. Faithful rather than unconditional: it fails
    // (and poisons the transaction) exactly when Postgres would — casting a
    // non-numeric bound parameter to int — so a test can also express the statement
    // that does NOT abort.
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?')
      store.operations.push('$executeRaw')
      store.rawStatements.push({ sql, params: values })
      if (store.aborted) throw new Error(ABORTED_TRANSACTION)
      const castsToInt = /CAST\(\?\s*AS\s+int\)/i.test(sql)
      if (castsToInt && Number.isNaN(Number(values[0]))) {
        store.aborted = true
        throw new Error(`invalid input syntax for type integer: "${String(values[0])}"`)
      }
      return 0
    },
    costLayer: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        guard('costLayer.create')
        const id = `layer-new-${++seq}`
        store.created.push({ id, ...data })
        store.layers.set(id, { id, sourceLines: [] })
        return { id }
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        guard('costLayer.findUnique')
        const layer = store.layers.get(where.id)
        if (!layer) return null
        return { receivedQty: 10, sourceLines: layer.sourceLines }
      },
      // The quantity postcondition RE-READS what was persisted rather than trusting
      // the helper's own tally, so an id it was handed for a layer that was never
      // written simply does not come back — which is the whole point.
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        guard('costLayer.findMany')
        return store.created.filter((layer) => where.id.in.includes(layer.id as string))
      },
    },
    costLayerSourceLine: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        guard('costLayerSourceLine.create')
        store.sourceLines.push(data)
        return data
      },
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        guard('costLayerSourceLine.createMany')
        store.sourceLines.push(...data)
        return { count: data.length }
      },
      count: async ({ where }: { where: { costLayerId: string } }) => {
        guard('costLayerSourceLine.count')
        return store.sourceLines.filter((line) => line.costLayerId === where.costLayerId).length
      },
    },
  }
  return { store, tx }
}

/**
 * The statements the helper issued OTHER than its entry probe. The precondition
 * added in round 6 issues `SAVEPOINT`/`RELEASE SAVEPOINT` on every call to establish
 * that it is inside a transaction (see assertHelperCanRefuseEffectively), so the
 * assertions about the ABORT statement have to name what they mean rather than
 * counting every raw statement.
 */
function abortStatements(store: Store) {
  return store.rawStatements.filter((statement) => !/SAVEPOINT/i.test(statement.sql))
}

/** Operations with the entry probe's two statements removed, in order. */
function operationsAfterEntryProbe(store: Store) {
  return store.operations.filter((operation) => !/^\$executeRawUnsafe:(SAVEPOINT|RELEASE SAVEPOINT)/i.test(operation))
}

const TARGET = {
  productId: 'prod-1',
  warehouseId: 'wh-dest',
  transferLineId: 'tl-1',
  contextLabel: 'transfer TR-1 receipt',
  // The stock the caller has already incremented. Every slice in this file is ten
  // units, so the default target books ten and expects them all to be costed; the
  // round-8 tests below vary it deliberately (Codex round-8 HIGH-1).
  bookedQty: 10,
  uncostedShortfall: 'REFUSE' as const,
}

test('a link-less PO-derived source layer gets a DIRECT link on the new layer (6oyu.19)', async () => {
  // The ordinary case, and the one the WMS paths got wrong. A PO layer has no
  // sourceLines of its own, so the proportional copy contributes nothing and the
  // direct fallback is the only thing that makes the new layer reachable.
  const { store, tx } = createStore(false)

  const result = await recreateTransferCostLayersFromSnapshotSlice(
    tx as never,
    TARGET,
    [{ costLayerId: 'layer-src', qty: '10.000000', unitCostBase: '5.000000' }],
  )

  assert.equal(result.createdLayers.length, 1)
  assert.equal(result.createdLayers[0].linkedDirectly, true)
  assert.deepEqual(
    store.sourceLines.map((line) => ({ costLayerId: line.costLayerId, sourceCostLayerId: line.sourceCostLayerId, qty: line.qty })),
    [{ costLayerId: 'layer-new-1', sourceCostLayerId: 'layer-src', qty: '10.000000' }],
  )
})

test('a source layer WITH provenance is linked by the proportional copy, not doubled (6oyu.19)', async () => {
  // The other reachable shape: the source carries its own source lines (it was
  // itself produced or transferred), so the copy points the new layer at the
  // ancestors a landed-cost recalc actually revalues. Writing the direct link as
  // well would double the provenance and inflate the propagated uplift.
  const { store, tx } = createStore(true)

  const result = await recreateTransferCostLayersFromSnapshotSlice(
    tx as never,
    TARGET,
    [{ costLayerId: 'layer-src', qty: '10.000000', unitCostBase: '5.000000' }],
  )

  assert.equal(result.createdLayers[0].linkedDirectly, false)
  assert.equal(store.sourceLines.length, 1, 'exactly one provenance record — copied, not copied AND fabricated')
  assert.equal(store.sourceLines[0].sourceCostLayerId, 'layer-grandparent')
})

test('the reachability postcondition FAILS when no link was written (6oyu.19)', async () => {
  // Proof the guard is not vacuous. The two tests above would pass with the
  // postcondition deleted, because the code paths they take do write a link. This
  // one reaches the guard with nothing written: the injected copier reports success
  // (so the direct fallback is skipped) while nothing is actually persisted —
  // exactly the shape the WMS paths had, where the copy's zero return was ignored.
  const { store, tx } = createStore(false)

  await assert.rejects(
    () => recreateTransferCostLayersFromSnapshotSlice(
      tx as never,
      TARGET,
      [{ costLayerId: 'layer-src', qty: '10.000000', unitCostBase: '5.000000' }],
      {
        createCostLayer: (async (client: unknown, data: unknown) => (tx as { costLayer: { create: (args: unknown) => Promise<{ id: string }> } })
          .costLayer.create({ data })
          .then((layer) => layer.id)) as never,
        copyCostLayerSourceLinesProportionally: (async () => 1) as never,
        logActivity: (async () => {}) as never,
      },
    ),
    /no\s+costLayerSourceLine/,
    'a layer with no provenance must not be left behind for a revaluation to miss',
  )
  // Precondition for the assertion above: the guard was reached with a real layer
  // created and genuinely zero links — not short-circuited before it ran.
  assert.equal(store.created.length, 1)
  assert.equal(store.sourceLines.length, 0)
})

// ---------------------------------------------------------------------------
// The negative-cost refusal (Codex round-5 HIGH, o3d-gd2f)
// ---------------------------------------------------------------------------

/**
 * The four call sites, as they configure the helper. All four route through ONE
 * function (pinned by the census below), so the refusal cannot differ between them —
 * these drive the shapes each path actually passes, including the WMS alignment's
 * adjustmentMovementId, so a future per-path branch would have to break one of them.
 */
const CALL_PATHS = [
  { name: 'manual receipt', target: { ...TARGET, contextLabel: 'transfer TR-1 receipt' } },
  { name: 'dispatch cancellation', target: { ...TARGET, warehouseId: 'wh-source', contextLabel: 'transfer TR-1 dispatch cancellation' } },
  { name: 'WMS webhook receipt', target: { ...TARGET, contextLabel: 'transfer TR-1 WMS receipt' } },
  { name: 'WMS stock-sync alignment', target: { ...TARGET, adjustmentMovementId: 'mv-1', contextLabel: 'transfer line tl-1 WMS stock-sync alignment' } },
] as const

const NEGATIVE_ENTRY = { costLayerId: 'layer-src', qty: '10.000000', unitCostBase: '-1.000000' }

for (const path of CALL_PATHS) {
  test(`a negative-cost snapshot entry is REFUSED on the ${path.name} path, with nothing created (o3d-gd2f)`, async () => {
    // Round 3 skipped the entry, leaving the caller's already-committed stock
    // increment unlayered. Round 4 created the layer at the negative cost, which the
    // downstream cannot represent: buildStockMovementValueFieldsFromTotal abs()es the
    // movement total (stock-movement-value.ts:75), so a -£4 layer books a +£4
    // TRANSFER_IN, and both connector daily syncs emit the COGS pair only when the
    // batch total is above zero (xero/daily-sync.ts:1970, quickbooks/daily-sync.ts:1197).
    // Round 5 refuses, and refusing is only safe because NOTHING is written.
    const { store, tx } = createStore(false)

    let captured: unknown = null
    try {
      await recreateTransferCostLayersFromSnapshotSlice(tx as never, path.target, [NEGATIVE_ENTRY])
      assert.fail('the helper must REFUSE a negative-cost entry, not return')
    } catch (thrown) {
      captured = thrown
    }
    assert.ok(
      captured instanceof NegativeCostSnapshotEntryError,
      `expected NegativeCostSnapshotEntryError, got ${captured instanceof Error ? captured.name + ': ' + captured.message : String(captured)}`,
    )

    // It NAMES the transfer line, the entry and the negative value — the three things
    // an operator needs to find the credit note that caused this.
    assert.match(captured.message, /tl-1/)
    assert.match(captured.message, /layer-src/)
    assert.match(captured.message, /-1\.000000\/unit/)
    assert.match(captured.message, new RegExp(path.target.contextLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.deepEqual(captured.entries, [{ index: 0, sourceCostLayerId: 'layer-src', qty: '10.000000', unitCostBase: '-1.000000' }])
    assert.equal(captured.transferLineId, 'tl-1')

    // NOTHING COMMITTED. This is the whole justification for refusing rather than
    // laying the layer down: the caller's stock increment goes with it.
    assert.deepEqual(store.created, [], 'no cost layer may be created')
    assert.deepEqual(store.sourceLines, [], 'and no provenance link either')
    assert.ok(
      !store.operations.some((operation) => operation.startsWith('costLayer.') || operation.startsWith('costLayerSourceLine.')),
      `nothing may even be ATTEMPTED before the refusal (saw ${store.operations.join(', ')})`,
    )
  })
}

// ---------------------------------------------------------------------------
// The entry precondition (Codex round-6 HIGH-2) — what replaced the static census
// ---------------------------------------------------------------------------

test('the helper REFUSES a client that is not inside a transaction, before touching anything (Codex r6)', async () => {
  // THE HARM THE WITHDRAWN CENSUS WAS HIDING. Outside a transaction the caller's
  // stock increment is already committed and the abort statement has nothing to
  // abort, so a caught refusal commits stock with no cost layers. The census
  // "passed" such a call site because it could not find a $transaction boundary —
  // it accepted the absence of evidence as evidence. This asks the client instead.
  const { store, tx } = createStore(false, { inTransaction: false })

  await assert.rejects(
    () => recreateTransferCostLayersFromSnapshotSlice(tx as never, TARGET, [
      { costLayerId: 'layer-src', qty: '10.000000', unitCostBase: '5.000000' },
    ]),
    (error: unknown) => {
      assert.ok(error instanceof TransferCostLayerRecreationContextError, `got ${String(error)}`)
      assert.equal(error.reason, 'not_in_transaction')
      assert.match(error.message, /25P01/)
      assert.match(error.message, /tl-1/)
      return true
    },
  )

  // A PERFECTLY ORDINARY, POSITIVE-COST slice: the refusal is about the CONTEXT, not
  // about this input, so it fires whether or not the rare negative case is present.
  assert.deepEqual(store.created, [], 'no cost layer may be created')
  assert.deepEqual(store.sourceLines, [], 'and no provenance link either')
  assert.ok(
    !store.operations.some((operation) => operation.startsWith('costLayer')),
    `nothing may be attempted outside a transaction (saw ${store.operations.join(', ')})`,
  )
})

test('the entry precondition is not vacuous: the SAME slice succeeds inside a transaction (Codex r6)', async () => {
  // Proves the refusal above discriminates rather than always firing — the check
  // could otherwise be "correct" while establishing nothing.
  const { store, tx } = createStore(false, { inTransaction: true })
  const result = await recreateTransferCostLayersFromSnapshotSlice(tx as never, TARGET, [
    { costLayerId: 'layer-src', qty: '10.000000', unitCostBase: '5.000000' },
  ])
  assert.equal(result.createdLayers.length, 1)
  assert.equal(store.created.length, 1)
  // And it really did probe: a SAVEPOINT was issued and released.
  const probes = store.rawStatements.filter((statement) => /SAVEPOINT/.test(statement.sql)).map((s) => s.sql)
  assert.equal(probes.length, 2, `expected a SAVEPOINT + RELEASE probe, saw ${JSON.stringify(probes)}`)
  assert.match(probes[0]!, /^SAVEPOINT /)
  assert.match(probes[1]!, /^RELEASE SAVEPOINT /)
})

test('the helper REFUSES a client with an open savepoint, which would undo its abort (Codex r6)', async () => {
  // ROLLBACK TO SAVEPOINT clears the aborted-transaction state, so a caller that
  // wrapped this call in withSavepoint could turn the refusal back into a skip. The
  // census tried to catch that by scanning for the identifier `withSavepoint`, which
  // an alias or a wrapper walks straight past. This reads the savepoint module's own
  // runtime state on the client, so HOW the savepoint was opened does not matter.
  const { store, tx } = createStore(false, { inTransaction: true })

  // Opened through an ALIAS, exactly the shape the scanner could not see.
  const openSavepointUnderAnAlias = withSavepoint
  await assert.rejects(
    () => openSavepointUnderAnAlias(tx as object, () =>
      recreateTransferCostLayersFromSnapshotSlice(tx as never, TARGET, [
        { costLayerId: 'layer-src', qty: '10.000000', unitCostBase: '5.000000' },
      ])),
    (error: unknown) => {
      assert.ok(error instanceof TransferCostLayerRecreationContextError, `got ${String(error)}`)
      assert.equal(error.reason, 'open_savepoint')
      return true
    },
  )
  assert.deepEqual(store.created, [], 'no cost layer may be created under a savepoint')
})

test('the savepoint refusal is not vacuous: depth returns to zero after the wrapper (Codex r6)', async () => {
  // If the depth counter never decremented, the test above would pass for the wrong
  // reason and every later call would refuse. Prove it comes back down and the same
  // call then succeeds on the same client.
  const { store, tx } = createStore(false, { inTransaction: true })
  await withSavepoint(tx as object, async () => {
    assert.equal(openSavepointDepth(tx as object), 1, 'the depth must actually rise inside the wrapper')
  })
  assert.equal(openSavepointDepth(tx as object), 0, 'and fall again on the way out')

  const result = await recreateTransferCostLayersFromSnapshotSlice(tx as never, TARGET, [
    { costLayerId: 'layer-src', qty: '10.000000', unitCostBase: '5.000000' },
  ])
  assert.equal(result.createdLayers.length, 1)
  assert.equal(store.created.length, 1)
})

test('a client with no raw escape hatch cannot prove the context, so it is refused (Codex r6)', async () => {
  // The helper's guarantee is that refusing STOPS a commit. A client that cannot be
  // asked has not established that, and running anyway is how a test double would
  // quietly opt out of the whole property in production code.
  const { tx } = createStore(false, { inTransaction: true })
  const { $executeRawUnsafe: _dropped, ...withoutRaw } = tx as Record<string, unknown>

  await assert.rejects(
    () => recreateTransferCostLayersFromSnapshotSlice(withoutRaw as never, TARGET, [
      { costLayerId: 'layer-src', qty: '10.000000', unitCostBase: '5.000000' },
    ]),
    (error: unknown) => {
      assert.ok(error instanceof TransferCostLayerRecreationContextError, `got ${String(error)}`)
      assert.equal(error.reason, 'no_raw_access')
      return true
    },
  )
})

test('the refusal aborts the transaction FIRST, so a caller that swallows it commits nothing (o3d-gd2f)', async () => {
  // THE PROPERTY THAT MAKES THE REFUSAL SAFE. Every caller has already incremented
  // stock in this same transaction, so a plain throw is not enough: caught and
  // ignored, the increment commits with no layer behind it — measured against a real
  // Postgres, 2 of 2 rows committed. The helper therefore runs a statement that is
  // guaranteed to fail before it throws.
  const { store, tx } = createStore(false)

  await assert.rejects(
    () => recreateTransferCostLayersFromSnapshotSlice(tx as never, TARGET, [NEGATIVE_ENTRY]),
    NegativeCostSnapshotEntryError,
  )

  // The abort statement was issued, with the sentinel BOUND rather than interpolated.
  const aborts = abortStatements(store)
  assert.equal(aborts.length, 1)
  assert.match(aborts[0]!.sql, /CAST\(\?\s*AS\s+int\)/i)
  assert.deepEqual(aborts[0]!.params, ['transfer_cost_layer_recreation_refused'])
  assert.equal(
    operationsAfterEntryProbe(store)[0],
    '$executeRaw',
    'the abort must precede every operation except the entry probe',
  )
  assert.equal(store.aborted, true)

  // Now BE the caller that swallows it: the transaction is already unusable, so the
  // stock increment it was about to commit cannot be committed.
  await assert.rejects(
    async () => {
      try {
        await recreateTransferCostLayersFromSnapshotSlice(tx as never, TARGET, [NEGATIVE_ENTRY])
      } catch {
        // "just skip this line and carry on" — the shape this defends against.
      }
      await (tx as { costLayer: { create: (args: unknown) => Promise<unknown> } })
        .costLayer.create({ data: { productId: 'prod-1', qty: '10' } })
    },
    new RegExp(ABORTED_TRANSACTION),
    'a swallowed refusal must leave the caller unable to write anything else',
  )
  assert.deepEqual(store.created, [], 'and still nothing was created')
})

test('the refusal FAILS CLOSED when the transaction cannot be aborted (o3d-gd2f)', async () => {
  // Proof the abort is not decorative. A client with no $executeRaw cannot be
  // poisoned, so the helper must not pretend it refused safely — it says exactly that
  // and still creates nothing. Checked outside the try in the implementation on
  // purpose: inside one, the TypeError would read as "the abort statement failed".
  const { store, tx } = createStore(false)
  const withoutRaw = { ...(tx as Record<string, unknown>) }
  delete withoutRaw.$executeRaw

  await assert.rejects(
    () => recreateTransferCostLayersFromSnapshotSlice(withoutRaw as never, TARGET, [NEGATIVE_ENTRY]),
    /exposes no \$executeRaw/,
  )
  assert.deepEqual(store.created, [])
})

test('an abort statement that SUCCEEDS is itself treated as a failure (o3d-gd2f)', async () => {
  // The other way the guarantee could quietly evaporate: the statement runs, does not
  // fail, and the transaction stays writable. The helper must not throw its ordinary
  // refusal in that case, because that refusal advertises a guarantee it no longer has.
  const { store, tx } = createStore(false)
  const alwaysSucceeds = { ...(tx as Record<string, unknown>), $executeRaw: async () => 0 }

  await assert.rejects(
    () => recreateTransferCostLayersFromSnapshotSlice(alwaysSucceeds as never, TARGET, [NEGATIVE_ENTRY]),
    /abort statement SUCCEEDED/,
  )
  assert.deepEqual(store.created, [])
})

test('a mixed slice refuses BEFORE laying down its positive entries (o3d-gd2f)', async () => {
  // The refusal is a whole-slice pre-pass, not a per-entry check inside the loop. The
  // transaction abort would roll a partial write back anyway, but "nothing was
  // attempted" is a stronger property than "everything was undone" — and it is the
  // one that survives someone later wrapping the call in a savepoint.
  const { store, tx } = createStore(false)

  await assert.rejects(
    () => recreateTransferCostLayersFromSnapshotSlice(tx as never, TARGET, [
      { costLayerId: 'layer-src', qty: '6.000000', unitCostBase: '5.000000' },
      { costLayerId: 'layer-src', qty: '4.000000', unitCostBase: '-1.000000' },
    ]),
    NegativeCostSnapshotEntryError,
  )
  assert.deepEqual(store.created, [], 'the positive entry must not be written either')
  assert.equal(operationsAfterEntryProbe(store)[0], '$executeRaw')
})

test('a negative cost on a ZERO-quantity entry is not refused (o3d-gd2f scope)', async () => {
  // The refusal is scoped to entries that would actually become a layer.
  // parseCostLayerSnapshot drops non-positive quantities and the loop skips them, so
  // such an entry lays down no units and books no movement value; refusing on one
  // would block a legitimate receipt over a row that changes nothing. Stated as a
  // test so that widening the scope is a decision rather than a drive-by.
  const { store, tx } = createStore(false)

  const result = await recreateTransferCostLayersFromSnapshotSlice(tx as never, TARGET, [
    { costLayerId: 'layer-src', qty: '0.000000', unitCostBase: '-1.000000' },
    { costLayerId: 'layer-src', qty: '10.000000', unitCostBase: '5.000000' },
  ])

  assert.equal(result.recreatedQty, '10.000000')
  assert.equal(store.created.length, 1)
  assert.deepEqual(abortStatements(store), [], 'nothing was refused, so nothing was aborted')
})

test('a recreated layer is consumable by the REAL FIFO consumer at the basis it carries (6oyu.19)', async () => {
  // Where the harm of a skip actually lands, and why refusing-with-nothing-committed
  // is a different thing from skipping-with-stock-committed. Drive the production FIFO
  // consumer over the layer this helper writes, then show the negative control: the
  // same 10 units on hand with NO layer is a straight FIFO shortfall valued at nothing.
  const { store, tx } = createStore(false)
  await recreateTransferCostLayersFromSnapshotSlice(
    tx as never,
    TARGET,
    [{ costLayerId: 'layer-src', qty: '10.000000', unitCostBase: '5.000000' }],
  )
  assert.equal(store.created.length, 1, 'precondition: the transfer layer exists to be consumed')

  function fifoTxFor(layers: Array<{ id: string; remainingQty: string; unitCostBase: string }>) {
    return {
      $executeRaw: async () => 0,
      $queryRaw: async () => layers.filter((layer) => Number(layer.remainingQty) > 0).map((layer) => ({ ...layer })),
      costLayer: {
        update: async ({ where, data }: { where: { id: string }; data: { remainingQty: { decrement: number } } }) => {
          const layer = layers.find((candidate) => candidate.id === where.id)
          if (layer) layer.remainingQty = String(Number(layer.remainingQty) - data.remainingQty.decrement)
          return layer
        },
      },
    }
  }

  const layers = store.created.map((layer, index) => ({
    id: `fifo-${index}`,
    remainingQty: String(layer.remainingQty),
    unitCostBase: String(layer.unitCostBase),
  }))
  const consumption = await consumeFifoLayers(fifoTxFor(layers) as never, 'prod-1', 'wh-dest', 4)

  assert.equal(consumption.remainingQty.toString(), '0', 'FIFO finds the units — no shortfall against on-hand')
  assert.equal(consumption.consumed.length, 1)
  assert.equal(consumption.consumed[0].qty.toString(), '4')
  assert.equal(consumption.consumed[0].unitCostBase.toString(), '5')
  assert.equal(consumption.totalCost.toString(), '20')
  assert.equal(layers[0].remainingQty, '6', 'and the layer is drawn down, so on-hand and Σ layer qty stay equal')

  // The negative control: unlayered stock is exactly a FIFO shortfall valued at £0.
  const unlayered = await consumeFifoLayers(fifoTxFor([]) as never, 'prod-1', 'wh-dest', 4)
  assert.equal(unlayered.remainingQty.toString(), '4', 'precondition: unlayered stock is exactly a FIFO shortfall')
  assert.equal(unlayered.totalCost.toString(), '0')
})

test('the quantity postcondition FAILS if an entry is not laid down (o3d-eiuo)', async () => {
  // Proof the guard is not vacuous. The tests above would all pass with the
  // postcondition deleted, because their entries are created. This one reaches the
  // guard with a real shortfall: the injected creator drops the second entry, exactly
  // the shape a skip has — stock already incremented by the caller, one entry's worth
  // of units left with no layer.
  const { store, tx } = createStore(false)

  await assert.rejects(
    () => recreateTransferCostLayersFromSnapshotSlice(
      tx as never,
      TARGET,
      [
        { costLayerId: 'layer-src', qty: '6.000000', unitCostBase: '5.000000' },
        { costLayerId: 'layer-src', qty: '4.000000', unitCostBase: '7.000000' },
      ],
      {
        createCostLayer: (async (client: unknown, data: { qty: unknown; unitCostBase: unknown }) => {
          // Skip the second entry while still handing back an id — the shape that
          // makes a skip invisible to a caller that only looks at the return value.
          if (Number(String(data.qty)) === 4) return 'layer-skipped'
          // Mirrors the real createCostLayer's qty -> receivedQty/remainingQty mapping,
          // so the re-read the postcondition performs sees a truthful row.
          return (tx as { costLayer: { create: (args: unknown) => Promise<{ id: string }> } })
            .costLayer.create({ data: { ...data, receivedQty: String(data.qty), remainingQty: String(data.qty) } })
            .then((layer) => layer.id)
        }) as never,
        copyCostLayerSourceLinesProportionally: (async () => 0) as never,
        logActivity: (async () => {}) as never,
      },
    ),
    /no FIFO layer behind them/,
    'declining an entry must fail loudly, not leave the caller\'s stock increment unlayered',
  )
  // Precondition: the guard was reached after a genuine partial creation, not
  // short-circuited before any work happened.
  assert.equal(store.created.length, 1, 'the positive entry WAS created — this is a shortfall, not a total failure')
  assert.equal(Number(store.created[0].receivedQty), 6)
})

// ---------------------------------------------------------------------------
// Census: no fifth path may open-code the sequence
// ---------------------------------------------------------------------------

const SCAN_ROOTS = ['app', 'lib']
/** The one call the censuses below are about. */
const CALL = 'recreateTransferCostLayersFromSnapshotSlice('

function walkTypeScript(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'generated' || entry === '.next') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walkTypeScript(full, out)
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full)
  }
  return out
}

test('every transfer-snapshot recreation goes through the shared helper (6oyu.19)', () => {
  // The defect was four copies of one three-line sequence, two of which dropped a
  // line. Rather than trusting future authors to remember, assert that any file
  // slicing a dispatch snapshot for receipt hands the slice to the helper and does
  // NOT build the layers itself.
  const files = SCAN_ROOTS.flatMap((root) => walkTypeScript(root))
  assert.ok(files.length > 100, `precondition: the walk must actually reach the source tree (saw ${files.length} files)`)

  const slicers: string[] = []
  const offenders: string[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    // The helper's own module and the slicer's own definition are not call sites.
    if (file.endsWith('transfer-cost-layer-recreation.ts')) continue
    if (file.endsWith('asn-reconciliation.ts')) continue
    if (!source.includes('sliceTransferSnapshotForReceipt(')) continue
    slicers.push(file)
    if (!source.includes('recreateTransferCostLayersFromSnapshotSlice(')) {
      offenders.push(`${file}: slices a dispatch snapshot but never calls the shared recreation helper`)
    }
  }

  assert.deepEqual(offenders, [], offenders.join('\n'))
  assert.deepEqual(
    slicers.sort(),
    [
      'app/actions/transfers.ts',
      'lib/connectors/mintsoft/sync/stock-sync.ts',
      'lib/domain/wms/booked-in-service.ts',
    ],
    'the set of snapshot-slicing files changed — a new one must route through the helper (and be listed here)',
  )
})

test('copyCostLayerSourceLinesProportionally has no unguarded caller left (6oyu.19)', () => {
  // The specific mistake was calling this helper and IGNORING its zero return. It is
  // still legitimately used elsewhere (refund restock), so this pins the call sites
  // rather than banning the function: a new one has to be justified here, where the
  // zero-return trap is written down.
  const files = SCAN_ROOTS.flatMap((root) => walkTypeScript(root))
  const callers = files
    .filter((file) => {
      const source = readFileSync(file, 'utf8')
      // Skip the definition itself (lib/cost-layers.ts declares it).
      return /(?<!function )\bcopyCostLayerSourceLinesProportionally\(/.test(source) && !file.endsWith('cost-layers.ts')
    })
    .sort()

  assert.deepEqual(
    callers,
    [
      // The ONE transfer-snapshot caller: it checks the return and falls back.
      'lib/domain/inventory/transfer-cost-layer-recreation.ts',
      // Refund restock — a different flow, whose destination layers are reached by
      // the refund-snapshot rewrite rather than by propagation (see
      // calculateLayerAdjustmentDeltas' returnedQty note). Listed so that changing
      // it is a decision, not a drive-by.
      'lib/domain/sales/refund-service.ts',
    ],
    'a new caller must handle the 0 return, or its layer is unreachable by landed-cost propagation',
  )
})

/**
 * THE STATIC CENSUS THAT USED TO LIVE HERE IS WITHDRAWN (Codex round-6 HIGH-2).
 *
 * It walked braces and parens backwards from each call site looking for a `try` or a
 * `withSavepoint` before the enclosing `$transaction(`, and asserted there were none
 * — the "belt" half of stopping a caller from turning the negative-cost refusal into
 * a silent skip. It could not do that job:
 *
 *  - It recognised only the bare identifier `withSavepoint`. A qualified call
 *    (`savepoints.withSavepoint`), an import alias, or any helper that wrapped it
 *    passed the census while still clearing the transaction abort on rollback. A
 *    name-based scanner over an open space is the shape that got a census withdrawn
 *    from o3d-n3yt and a guard surface withdrawn from o3d-8td2; a cleverer scanner
 *    would fail the same way, so this one is removed rather than improved.
 *  - Worse, it PASSED a call site where it found no `$transaction` boundary at all,
 *    which is what happens for the call inside `applyTransferLineReceipt`: that
 *    function is handed its `tx` by `receiveTransfer` / `receiveTransferPartial`, so
 *    the boundary is in the caller and no lexical walk can reach it. The census
 *    reported "no offenders" for a call site about which it had established nothing.
 *
 * WHAT REPLACED IT is a runtime entry precondition inside the helper itself —
 * `assertHelperCanRefuseEffectively` — which asks the CLIENT it was handed, not the
 * source text: Postgres answers whether there is a transaction (25P01 on a probe
 * SAVEPOINT), and the savepoint module answers whether it has one open on that
 * client. Aliases, wrappers and interprocedural boundaries are all irrelevant to
 * both questions, and a `try` around the call is covered because the abort survives
 * the catch. Those checks are exercised against a real PostgreSQL in
 * tests/concurrency/transfer-cost-layer-recreation-context.concurrent.test.ts and
 * against doubles below.
 */

// ---------------------------------------------------------------------------
// What the call sites are allowed to SAY about the helper (Codex r4 + r5 LOW)
// ---------------------------------------------------------------------------

/**
 * THE EXACT TEXT each call site may carry above its call, normalised (comment markers
 * stripped, whitespace collapsed). An ALLOWLIST, not a pattern.
 *
 * Round 4 shipped a regex for "settles the/any/those <something>". Codex round 5 was
 * right that it is still a pattern over an open space: "settles deferred transit
 * reclassification" passes it, and so does "completes the deferred reclassification".
 * A third regex would fail the same way, so the subject is closed instead — these four
 * blocks, verbatim. ANY edit to a call-site comment fails this test, which is the
 * point: the claim a maintainer reads there is the one thing that decided, twice, that
 * the in-transit gap (o3d-nrl4) was handled when it is not.
 *
 * WHAT THIS DOES NOT COVER, stated rather than implied: prose about the helper
 * ELSEWHERE — in these files, in the helper's own module comment, in docs/ — is not
 * policed by anything. It cannot be, and this test does not pretend otherwise.
 * Updating a block below is a normal, expected edit; it just has to be a deliberate one.
 */
const ALLOWED_CALL_SITE_COMMENTS: Record<string, string[]> = {
  'app/actions/transfers.ts': [
    "Recreate FIFO layers at the destination from the unconsumed slice of the dispatch snapshot (the slicer walks past alreadyReceivedQty and returns the next qtyToReceive units). The shared helper GUARANTEES two things about the layers it creates — each is reachable by propagateLandedCostToOutputs, and together they cover the slice's whole quantity — so never open-code this. It REFUSES a snapshot entry whose unit cost is negative (Codex round-5 HIGH, o3d-gd2f): nothing downstream can carry the sign, so it creates nothing and aborts this transaction rather than let the stock increment above commit alone. Do NOT wrap this call in a try or a savepoint. It settles NOTHING (Codex round-4 LOW). A landed-cost revaluation that landed while these units were in transit had no layer to journal against and IMS persisted no obligation for it; creating the layer now does not discharge it, and the delta is still sitting in the transit clearing account. That gap is open and tracked as o3d-nrl4 — see the contract on STOCK_TRANSFER_SOURCE_LAYER_CONSUMPTION.IN_TRANSIT. `bookedQty` is the stock increment made immediately above, and the helper's coverage postcondition is measured against IT, not against the slice (Codex round-8 HIGH-1). cogs-audit scjz.5's £0 balancing layer for an under-recording dispatch snapshot is now the helper's `BALANCE_AT_ZERO_COST` policy: it used to be built here, and the three other call sites — which increment stock the same way — did not build one at all.",
    "Recreate FIFO layers at the SOURCE from the snapshot slice (mirrors the destination recreation in receiveTransfer, targeting fromWarehouseId). Note: the ORIGINAL layers consumed at dispatch are NOT un-consumed; this creates equivalent replacement layers (same cost basis + source-line provenance), so source quantity reconciles with cost layers. Same shared helper as the receipt path, for the same two guarantees: each replacement layer is reachable by propagation, and the layers cover the whole restored quantity (this path has no balancing step of its own, so a layer the helper declined would leave the restored stock unlayered — Codex round-4 HIGH). It REFUSES a snapshot entry whose unit cost is negative (Codex round-5 HIGH, o3d-gd2f), creating nothing and aborting this transaction rather than let the restore above commit alone. Do NOT wrap this call in a try or a savepoint. A cancellation is the OTHER way in-transit units come to rest, and it settles no deferred reclass either (Codex round-4 LOW): a revaluation that landed mid-transit was never persisted as an obligation, so nothing here discharges it and the delta stays in the transit clearing account. Open, tracked as o3d-nrl4. `bookedQty` is the restore increment above (Codex round-8 HIGH-1). This path restores the FULL outstanding line quantity, and the snapshot can cover less than that — a source that dispatched legacy/uncosted stock is the ordinary case, and `linesMissingCostLayers` above counts only the TOTALLY uncovered one. A partial shortfall used to pass the helper's slice-scoped check and leave restored stock unlayered at the source.",
  ],
  'lib/connectors/mintsoft/sync/stock-sync.ts': [
    "6oyu.19: same omission as the WMS webhook receipt path — the created layer had no costLayerSourceLine whenever the source was a plain PO-derived layer, stranding the landed-cost delta. Routed through the shared helper so the link is guaranteed, not remembered — and so is the quantity: stock is incremented for this allocation below, and an entry the helper declined would leave it unlayered (Codex round-4 HIGH). It REFUSES a snapshot entry whose unit cost is negative (Codex round-5 HIGH, o3d-gd2f), creating nothing and aborting this transaction rather than let the allocation's stock increment commit alone. Do NOT wrap this call in a try or a savepoint. Note this alignment does NOT change the transfer's status, so a transfer can be IN_TRANSIT with these units fully layered and propagatable. What is still uncovered is a revaluation that landed while units were in transit: nothing here discharges it and the delta stays in the transit clearing account. Open, tracked as o3d-nrl4. `bookedQty` is `allocation.qty`, the stock increment made below, and the helper's coverage postcondition is measured against IT (Codex round-8 HIGH-1). The old postcondition compared the created layers with the SLICE, and the slice is only as long as the snapshot allowed — a ten-unit allocation over a six-unit remaining snapshot compared six with six and passed, then incremented stock by ten. `REFUSE` rather than `BALANCE_AT_ZERO_COST`, and it is a backstop rather than a route: the plan above is already capped by `remainingCostableSnapshotQty`, so a shortfall here means the cap and the slicer have come to disagree. Alignment is an OPTIONAL auto-correction of a WMS/IMS discrepancy — unlike the three receipt paths, nothing is physically waiting to be booked — so inventing £0 units to push an optional correction through would be strictly worse than leaving the discrepancy where an operator can see it.",
  ],
  'lib/domain/wms/booked-in-service.ts': [
    "6oyu.19: this loop used to create the destination layer and call copyCostLayerSourceLinesProportionally IGNORING its result, which is 0 for an ordinary PO-derived source layer (it has no sourceLines of its own). The layer was therefore left with no costLayerSourceLine, so the revaluation exclusion removed these units from COGS while propagation had nowhere to carry the delta. The shared helper makes the link a postcondition, and the quantity too — this path increments stock immediately above and has no balancing layer, so an entry the helper declined would leave the booked-in units unlayered (Codex round-4 HIGH). It REFUSES a snapshot entry whose unit cost is negative (Codex round-5 HIGH, o3d-gd2f), creating nothing and aborting this transaction rather than let the stock increment above commit alone. Do NOT wrap this call in a try or a savepoint. It settles NO deferred transit reclass (Codex round-4 LOW). A landed-cost revaluation that landed while these units were in transit was never persisted as an obligation, so creating the layer does not discharge it; the delta remains in the transit clearing account. Open, tracked as o3d-nrl4. `bookedQty` is `stockQtyToAdd`, the increment made immediately above, and the helper's coverage postcondition is measured against IT rather than against the slice (Codex round-8 HIGH-1). The two differ whenever the dispatch snapshot has fewer unconsumed costed units than the WMS has booked in, and this path has no balancing step of its own, so the difference used to go on hand unlayered. BALANCE_AT_ZERO_COST rather than REFUSE because the goods are physically in the warehouse — refusing would fail a real receipt that Mintsoft has already completed — and because the movement written above already values them at the slice's total, i.e. it has already priced the shortfall at zero.",
  ],
}

test('each call site says exactly what it is allowed to say about the helper (Codex r5 LOW)', () => {
  const files = Object.keys(ALLOWED_CALL_SITE_COMMENTS).sort()
  assert.deepEqual(
    files,
    SCAN_ROOTS.flatMap((root) => walkTypeScript(root))
      .filter((file) => readFileSync(file, 'utf8').includes(CALL))
      .filter((file) => !file.endsWith('transfer-cost-layer-recreation.ts'))
      .sort(),
    'a new caller file must have its call-site comment allowlisted here',
  )

  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n')
    const blocks: string[] = []
    for (const [index, line] of lines.entries()) {
      if (!line.includes(CALL)) continue
      let start = index
      while (start > 0 && /^\s*\/\//.test(lines[start - 1])) start -= 1
      blocks.push(
        lines.slice(start, index)
          .map((commentLine) => commentLine.replace(/^\s*\/\/ ?/, '').trim())
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
      )
    }
    assert.deepEqual(
      blocks,
      ALLOWED_CALL_SITE_COMMENTS[file],
      `${file}: a call-site comment changed. Re-read it against what the helper actually does — it ` +
      `creates propagation links and refuses a negative basis; it settles nothing and completes nothing ` +
      `(o3d-nrl4 is still open) — then update ALLOWED_CALL_SITE_COMMENTS deliberately.`,
    )
    assert.ok(
      readFileSync(file, 'utf8').includes('o3d-nrl4'),
      `${file}: must name the still-open in-transit gap rather than leaving the reader to assume it is handled`,
    )
  }
})

// ---------------------------------------------------------------------------
// Codex round 8, HIGH-1: the postcondition measured the SLICE, not the booking
// ---------------------------------------------------------------------------

/**
 * A ten-unit booking whose dispatch snapshot has only six unconsumed units left.
 * This is the finding's exact input: the slice is SHORTER than the allocation, so
 * the round-4 postcondition compares six against six and passes while the caller's
 * stock increment of ten stands over six units of layer.
 */
const SHORT_SLICE = [{ costLayerId: 'layer-src', qty: '6.000000', unitCostBase: '5.000000' }]

test('the round-4 postcondition PASSES on the short slice — this is what made it invisible (Codex r8 HIGH-1)', async () => {
  // THE PROOF THAT THE OLD CHECK COULD NOT SEE THIS. Both of its figures are derived
  // from the slice, so a faithful loop always satisfies it. Run the same input under
  // BALANCE and read `recreatedQty`: six requested, six created, check satisfied —
  // and, before this round, that was the whole of the function's quantity guarantee
  // while ten units were going on hand.
  const { store, tx } = createStore(false)
  const result = await recreateTransferCostLayersFromSnapshotSlice(
    tx as never,
    { ...TARGET, bookedQty: 10, uncostedShortfall: 'BALANCE_AT_ZERO_COST' },
    SHORT_SLICE,
    {
      createCostLayer: (async (client: unknown, data: { qty: unknown }) =>
        (tx as { costLayer: { create: (args: unknown) => Promise<{ id: string }> } })
          .costLayer.create({ data: { ...data, receivedQty: String(data.qty), remainingQty: String(data.qty) } })
          .then((layer) => layer.id)) as never,
      // 0 — the ordinary PO-derived source layer, so the helper writes the direct
      // provenance link and its reachability postcondition is satisfied.
      copyCostLayerSourceLinesProportionally: (async () => 0) as never,
      logActivity: (async () => {}) as never,
    },
  )

  // The round-4 figure. It agrees with the slice, exactly as it always did.
  assert.equal(result.recreatedQty, '6.000000', 'the slice-scoped postcondition is satisfied by six units')
  // And the round-8 figure, which is measured against the ten the caller booked.
  assert.equal(result.bookedCoverageQty, '10.000000', 'coverage must be measured against the BOOKED quantity')
  assert.ok(result.balancingLayer, 'the four uncosted units must be backed by a balancing layer')
  assert.equal(result.balancingLayer!.qty, '4.000000')
  assert.equal(store.created.length, 2, 'one costed layer of six and one £0 layer of four')
  assert.equal(Number(store.created[1]!.unitCostBase), 0, 'the balancing layer is at zero cost')
  assert.equal(Number(store.created[1]!.receivedQty), 4)
  // The identity the caller's stock increment rests on.
  assert.equal(
    store.created.reduce((sum, layer) => sum + Number(layer.receivedQty), 0),
    10,
    'Σ layer receivedQty must equal the booked quantity — this is the assertion that fails without the fix',
  )
})

test('the balancing layer logs a WARNING naming the shortfall (Codex r8 HIGH-1)', async () => {
  // Silent conservation is how the round-3 skip hid. The £0 layer is a real
  // stock/cost-layer desync at the SOURCE warehouse and has to be reportable.
  const { tx } = createStore(false)
  const logged: Array<Record<string, unknown>> = []
  await recreateTransferCostLayersFromSnapshotSlice(
    tx as never,
    { ...TARGET, bookedQty: 10, uncostedShortfall: 'BALANCE_AT_ZERO_COST' },
    SHORT_SLICE,
    {
      createCostLayer: (async (client: unknown, data: { qty: unknown }) =>
        (tx as { costLayer: { create: (args: unknown) => Promise<{ id: string }> } })
          .costLayer.create({ data: { ...data, receivedQty: String(data.qty), remainingQty: String(data.qty) } })
          .then((layer) => layer.id)) as never,
      copyCostLayerSourceLinesProportionally: (async () => 0) as never,
      logActivity: (async (params: Record<string, unknown>) => { logged.push(params) }) as never,
    },
  )

  assert.equal(logged.length, 1)
  assert.equal(logged[0]!.action, 'transfer_uncosted_balancing_layer')
  assert.equal(logged[0]!.level, 'WARNING')
  assert.match(String(logged[0]!.description), /4\.000000-unit shortfall/)
  assert.equal((logged[0]!.metadata as Record<string, unknown>).bookedQty, '10.000000')
  assert.equal((logged[0]!.metadata as Record<string, unknown>).costedQty, '6.000000')
})

test('REFUSE aborts the transaction and creates nothing when the booking is uncosted (Codex r8 HIGH-1)', async () => {
  // The WMS stock-sync alignment's policy. Alignment is an OPTIONAL correction, so
  // inventing £0 units to push it through is worse than leaving the discrepancy
  // where an operator can see it. Same abort-first discipline as the negative-cost
  // refusal, for the same reason: the caller has already incremented stock.
  const { store, tx } = createStore(false)

  let captured: unknown = null
  try {
    await recreateTransferCostLayersFromSnapshotSlice(
      tx as never,
      { ...TARGET, bookedQty: 10, uncostedShortfall: 'REFUSE' },
      SHORT_SLICE,
    )
    assert.fail('a booking the snapshot cannot cost must be REFUSED under this policy')
  } catch (thrown) {
    captured = thrown
  }

  assert.ok(
    captured instanceof UncostedBookedQuantityError,
    `expected UncostedBookedQuantityError, got ${captured instanceof Error ? `${captured.name}: ${captured.message}` : String(captured)}`,
  )
  assert.equal(captured.bookedQty, '10.000000')
  assert.equal(captured.costedQty, '6.000000')
  assert.equal(captured.shortfallQty, '4.000000')
  assert.equal(captured.transferLineId, 'tl-1')
  assert.equal(store.aborted, true, 'the refusal must abort FIRST, so a caller cannot swallow it and commit')

  // And the caller who swallows it can write nothing else.
  await assert.rejects(
    () => (tx as { costLayer: { create: (args: unknown) => Promise<unknown> } })
      .costLayer.create({ data: { productId: 'prod-1', qty: '10' } }),
    new RegExp(ABORTED_TRANSACTION),
  )
})

test('a booking the snapshot covers exactly creates no balancing layer (Codex r8 — not vacuous)', async () => {
  // If the shortfall branch fired unconditionally, every test above would pass for
  // the wrong reason and every ordinary receipt would grow a spurious £0 layer.
  const { store, tx } = createStore(false)
  const result = await recreateTransferCostLayersFromSnapshotSlice(
    tx as never,
    { ...TARGET, bookedQty: 10, uncostedShortfall: 'BALANCE_AT_ZERO_COST' },
    [{ costLayerId: 'layer-src', qty: '10.000000', unitCostBase: '5.000000' }],
  )
  assert.equal(result.balancingLayer, null)
  assert.equal(result.recreatedQty, '10.000000')
  assert.equal(result.bookedCoverageQty, '10.000000')
  assert.equal(store.created.length, 1)
})

test('a slice LONGER than the booking is refused too — the check binds both ways (Codex r8)', async () => {
  // The other direction of "the two quantities cannot disagree". A caller that books
  // six and hands over a ten-unit slice would lay down layers for stock nobody
  // incremented, which inflates on-hand value rather than deflating it. The old
  // check could not see this either.
  const { tx } = createStore(false)
  await assert.rejects(
    () => recreateTransferCostLayersFromSnapshotSlice(
      tx as never,
      { ...TARGET, bookedQty: 6, uncostedShortfall: 'BALANCE_AT_ZERO_COST' },
      [{ costLayerId: 'layer-src', qty: '10.000000', unitCostBase: '5.000000' }],
    ),
    /booked 6\.000000 units[\s\S]*but 10\.000000 units are/,
  )
})

test('the QUANTITY postconditions abort the transaction too, not just the cost refusals (Codex r8)', async () => {
  // Both quantity checks used to be plain throws. Every caller has already
  // incremented stock when they fire, so a caller that caught one and carried on
  // committed exactly the unlayered stock they exist to prevent — the same hole the
  // negative-cost refusal was given an abort for in round 5.
  //
  // Driven through the SLICE check (a declined entry), because that one is
  // reachable with a stub and its abort is the older of the two.
  const { store, tx } = createStore(false)
  await assert.rejects(
    () => recreateTransferCostLayersFromSnapshotSlice(
      tx as never,
      { ...TARGET, bookedQty: 10, uncostedShortfall: 'BALANCE_AT_ZERO_COST' },
      [
        { costLayerId: 'layer-src', qty: '6.000000', unitCostBase: '5.000000' },
        { costLayerId: 'layer-src', qty: '4.000000', unitCostBase: '7.000000' },
      ],
      {
        createCostLayer: (async (client: unknown, data: { qty: unknown }) => {
          if (Number(String(data.qty)) === 4) return 'layer-skipped'
          return (tx as { costLayer: { create: (args: unknown) => Promise<{ id: string }> } })
            .costLayer.create({ data: { ...data, receivedQty: String(data.qty), remainingQty: String(data.qty) } })
            .then((layer) => layer.id)
        }) as never,
        copyCostLayerSourceLinesProportionally: (async () => 0) as never,
        logActivity: (async () => {}) as never,
      },
    ),
    /no FIFO layer behind them/,
  )

  assert.equal(store.aborted, true, 'the quantity postcondition must poison the transaction before throwing')
  // And prove the abort bites: the caller who swallows it can write nothing else.
  await assert.rejects(
    () => (tx as { costLayer: { create: (args: unknown) => Promise<unknown> } })
      .costLayer.create({ data: { productId: 'prod-1', qty: '10' } }),
    new RegExp(ABORTED_TRANSACTION),
    'a swallowed quantity refusal must leave the caller unable to commit its stock increment',
  )
})
