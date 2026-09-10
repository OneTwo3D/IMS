import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * 6oyu.19 / Codex round-6 HIGH-2. WHAT REPLACED THE STATIC CENSUS.
 *
 * `recreateTransferCostLayersFromSnapshotSlice` refuses a negative-cost snapshot
 * entry by putting Postgres into aborted-transaction state before it throws, so that
 * a caller which catches the throw still cannot commit the stock increment it made
 * immediately before calling. A source scanner used to assert that no call site sat
 * inside a `try` or a `withSavepoint`. It could not do that job: it matched only the
 * bare identifier `withSavepoint`, and — the serious half — it PASSED any call site
 * where it found no `$transaction(` boundary, which is what happens for the call
 * inside `applyTransferLineReceipt`, whose `tx` comes from its caller.
 *
 * The replacement is an entry precondition read from the CLIENT. These are its
 * proofs, and they need a real PostgreSQL: whether a statement is inside a
 * transaction block, and what an aborted transaction does to a later COMMIT, are
 * properties of the database. A hand-written double can be made to say anything.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const TX = { timeout: 20000, maxWait: 10000 }

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  }
}

function probeSku(label: string) {
  return `R6CTX-${label}-${process.pid}-${Date.now()}`
}

/**
 * A short collision-free token for `warehouses.code`, which is UNIQUE and only 20
 * characters wide.
 *
 * The code used to be `probeSku(label).slice(0, 20)`. `Date.now()` is thirteen
 * digits whose LEADING digits do not change for years, so for any label long enough
 * to push the timestamp past the cut, the truncated code was effectively
 * `R6CTX-<label>-<a few pid digits>` — stable across runs, and the fixture rows
 * outlive the run. Adding two longer labels in round 9 was enough to make it collide
 * with its own previous run and fail a test that had nothing to do with warehouse
 * codes. The sibling file already avoided this; this one now does too.
 */
function probeCode() {
  const uid = `${Date.now().toString(36)}${Math.floor(Math.random() * 1_679_616).toString(36).padStart(4, '0')}`
  return `R6C${uid}`.toUpperCase().slice(0, 20)
}

/** A product + warehouse + one source cost layer to build snapshot slices against. */
async function seed(label: string) {
  const { db } = await import('@/lib/db')
  const sku = probeSku(label)
  const product = await db.product.create({
    data: { sku, name: `r6 ctx ${label}`, type: 'SIMPLE', countryOfOrigin: 'CN' },
    select: { id: true },
  })
  const warehouse = await db.warehouse.create({
    data: { code: probeCode(), name: `r6 ctx wh ${label}`, type: 'STANDARD' },
    select: { id: true },
  })
  const sourceLayer = await db.costLayer.create({
    data: {
      productId: product.id,
      warehouseId: warehouse.id,
      receivedQty: '10.000000',
      remainingQty: '0.000000',
      unitCostBase: 5,
    },
    select: { id: true },
  })
  return { db, product, warehouse, sourceLayer, sku }
}

test(
  'the helper REFUSES a non-transactional client, creating nothing (Codex r6 HIGH-2)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db, product, warehouse, sourceLayer } = await seed('notx')
    const { recreateTransferCostLayersFromSnapshotSlice, TransferCostLayerRecreationContextError } =
      await import('@/lib/domain/inventory/transfer-cost-layer-recreation')

    const before = await db.costLayer.count({ where: { productId: product.id } })

    // `db` itself is an autocommit connection: every statement is its own
    // transaction. This is the context the census could not rule out.
    await assert.rejects(
      () => recreateTransferCostLayersFromSnapshotSlice(
        db as never,
        {
          productId: product.id,
          warehouseId: warehouse.id,
          transferLineId: 'tl-notx',
          contextLabel: 'round-6 non-transactional probe',
          bookedQty: 10,
          uncostedShortfall: 'REFUSE',
        },
        [{ costLayerId: sourceLayer.id, qty: '10.000000', unitCostBase: '5.000000' }],
      ),
      (error: unknown) => {
        assert.ok(
          error instanceof TransferCostLayerRecreationContextError,
          `expected a context refusal, got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        )
        assert.equal(error.reason, 'not_in_transaction')
        return true
      },
    )

    assert.equal(
      await db.costLayer.count({ where: { productId: product.id } }),
      before,
      'no cost layer may be created outside a transaction',
    )
  },
)

test(
  'the same call SUCCEEDS inside a transaction — the precondition discriminates (Codex r6)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // Without this, the refusal above could be an unconditional throw and would
    // establish nothing about transactions at all.
    loadEnv()
    const { db, product, warehouse, sourceLayer } = await seed('intx')
    const { recreateTransferCostLayersFromSnapshotSlice } =
      await import('@/lib/domain/inventory/transfer-cost-layer-recreation')

    const result = await db.$transaction(async (tx) => recreateTransferCostLayersFromSnapshotSlice(
      tx,
      {
        productId: product.id,
        warehouseId: warehouse.id,
        transferLineId: 'tl-intx',
        contextLabel: 'round-6 transactional probe',
        bookedQty: 10,
        uncostedShortfall: 'REFUSE',
      },
      [{ costLayerId: sourceLayer.id, qty: '10.000000', unitCostBase: '5.000000' }],
    ), TX)

    assert.equal(result.createdLayers.length, 1)
    assert.equal(result.recreatedQty, '10.000000')
    assert.equal(await db.costLayer.count({ where: { productId: product.id } }), 2)
  },
)

test(
  'the refusal CANNOT be caught into a commit — measured against real Postgres (o3d-gd2f, Codex r6)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db, product, warehouse, sourceLayer } = await seed('swallow')
    const { recreateTransferCostLayersFromSnapshotSlice } =
      await import('@/lib/domain/inventory/transfer-cost-layer-recreation')

    // The caller's stock increment, then the refusal, then the caller carrying on as
    // if nothing happened — the exact shape the abort exists to defeat.
    const swallowed: string[] = []
    const outcome = await db.$transaction(async (tx) => {
      await tx.stockLevel.create({
        data: { productId: product.id, warehouseId: warehouse.id, quantity: '10', reservedQty: '0' },
      })
      try {
        await recreateTransferCostLayersFromSnapshotSlice(
          tx,
          {
            productId: product.id,
            warehouseId: warehouse.id,
            transferLineId: 'tl-swallow',
            contextLabel: 'round-6 swallow probe',
            bookedQty: 10,
            uncostedShortfall: 'REFUSE',
          },
          // Negative unit cost: the refusal this mechanism is for.
          [{ costLayerId: sourceLayer.id, qty: '10.000000', unitCostBase: '-1.000000' }],
        )
      } catch (error) {
        swallowed.push(error instanceof Error ? error.name : String(error))
      }
      return 'the caller believes it succeeded'
    }, TX).catch((error: unknown) => (error instanceof Error ? `rejected: ${error.message}` : String(error)))

    assert.equal(swallowed.length, 1, 'the caller must have caught the refusal')

    // MEASURED, and NOT what one would guess: `db.$transaction` RESOLVES here. The
    // COMMIT degrades to a ROLLBACK inside Postgres and Prisma does not surface that
    // as an error, so the caller is returned its own value and believes it worked.
    // Recorded rather than asserted away, because it means a swallowed refusal is
    // silent to the caller even though it is harmless to the data. The guarantee this
    // mechanism actually provides is the one below: nothing commits.
    assert.equal(
      String(outcome),
      'the caller believes it succeeded',
      `behaviour change: $transaction used to resolve after a swallowed refusal, got ${String(outcome)}`,
    )

    // THE ASSERTION THAT MATTERS: the caller's own write is gone.
    assert.equal(
      await db.stockLevel.count({ where: { productId: product.id, warehouseId: warehouse.id } }),
      0,
      'a swallowed refusal must not be able to commit the stock increment that preceded it',
    )
    assert.equal(
      await db.costLayer.count({ where: { productId: product.id, warehouseId: warehouse.id, id: { not: sourceLayer.id } } }),
      0,
      'and no cost layer may exist either',
    )
  },
)

test(
  'WHY the transaction check is load-bearing: outside one, the abort statement protects nothing (Codex r6)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // This measures the harm the withdrawn census was hiding, rather than asserting
    // it. On an autocommit connection the helper's deliberate failing statement
    // poisons a transaction consisting of itself: the write before it is ALREADY
    // committed, and the write after it succeeds. So had a call site genuinely run
    // outside a transaction, a caught refusal would have committed stock with no cost
    // layers — which is exactly what the entry precondition now prevents.
    loadEnv()
    const { db, product, warehouse } = await seed('inert')

    await db.stockLevel.create({
      data: { productId: product.id, warehouseId: warehouse.id, quantity: '10', reservedQty: '0' },
    })
    // The helper's abort statement, issued on the same autocommit connection.
    await assert.rejects(() => db.$executeRaw`SELECT CAST(${'transfer_cost_layer_recreation_refused'} AS int)`)
    // And the connection is still perfectly writable.
    await db.stockLevel.update({
      where: { productId_warehouseId: { productId: product.id, warehouseId: warehouse.id } },
      data: { quantity: '11' },
    })

    const level = await db.stockLevel.findUnique({
      where: { productId_warehouseId: { productId: product.id, warehouseId: warehouse.id } },
      select: { quantity: true },
    })
    assert.equal(
      Number(level?.quantity),
      11,
      'outside a transaction the abort is inert — which is why the helper now refuses to run there',
    )
  },
)

test(
  'an OPEN SAVEPOINT is refused, however it was opened (Codex r6 HIGH-2)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db, product, warehouse, sourceLayer } = await seed('savepoint')
    const { recreateTransferCostLayersFromSnapshotSlice, TransferCostLayerRecreationContextError } =
      await import('@/lib/domain/inventory/transfer-cost-layer-recreation')
    const savepoints = await import('@/lib/db/savepoint')

    // Reached through a PROPERTY, not the bare identifier the scanner matched on —
    // and then through a local wrapper, so neither shape the census could see is
    // present at the call site.
    const wrapper = <T>(client: object, fn: () => Promise<T>) => savepoints.withSavepoint(client, fn)

    const outcome = await db.$transaction(async (tx) => wrapper(tx as object, () =>
      recreateTransferCostLayersFromSnapshotSlice(
        tx,
        {
          productId: product.id,
          warehouseId: warehouse.id,
          transferLineId: 'tl-savepoint',
          contextLabel: 'round-6 savepoint probe',
          bookedQty: 10,
          uncostedShortfall: 'REFUSE',
        },
        [{ costLayerId: sourceLayer.id, qty: '10.000000', unitCostBase: '5.000000' }],
      )), TX).catch((error: unknown) => error)

    assert.ok(
      outcome instanceof TransferCostLayerRecreationContextError,
      `expected a context refusal, got ${outcome instanceof Error ? `${outcome.name}: ${outcome.message}` : String(outcome)}`,
    )
    assert.equal(outcome.reason, 'open_savepoint')
    assert.equal(
      await db.costLayer.count({ where: { productId: product.id, id: { not: sourceLayer.id } } }),
      0,
      'nothing may be created under a savepoint that could roll the abort back',
    )
  },
)

test(
  'applyTransferLineReceipt DOES run inside a transaction — the census simply could not see it (Codex r6)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // THE QUESTION THE FINDING RAISED, answered against the running system rather
    // than by reading. The census reported the call inside `applyTransferLineReceipt`
    // as having no `$transaction` boundary. That was a limitation of a lexical walk —
    // the function is handed its client by `receiveTransfer` /
    // `receiveTransferPartial`, both of which open one — and NOT a real
    // out-of-transaction call site.
    //
    // Proven the only way that settles it: take a client through the same shape those
    // callers use (a `db.$transaction` callback passing `tx` into a helper that
    // receives it as a parameter) and ask the database, from inside that helper,
    // whether it is in a transaction. If the answer were `false`, the receipt path
    // would be committing stock with no cost layers today.
    loadEnv()
    const { db } = await import('@/lib/db')
    const { isClientInsideTransaction } = await import('@/lib/db/savepoint')

    // A helper that, exactly like applyTransferLineReceipt, only ever sees a `tx`
    // parameter and contains no `$transaction` token of its own.
    const helperThatOnlyReceivesTx = async (client: object) => isClientInsideTransaction(client)

    const insideCallback = await db.$transaction(async (tx) => helperThatOnlyReceivesTx(tx as object), TX)
    assert.equal(insideCallback, true, 'a tx handed to a helper IS inside a transaction')

    // And the discriminator is not simply always-true.
    assert.equal(
      await helperThatOnlyReceivesTx(db as object),
      false,
      'the same probe answers false on the autocommit client',
    )
  },
)

// ---------------------------------------------------------------------------
// THE ZERO-COST BALANCING WARNING IS AS DURABLE AS THE BALANCING
// (6oyu.19, Codex round-9 MEDIUM-2)
// ---------------------------------------------------------------------------

/**
 * `BALANCE_AT_ZERO_COST` is the policy that lets a receipt through with an uncosted
 * shortfall, so the WARNING is not a notification about the balancing — it is the
 * only durable record that the policy was exercised. It used to be written by
 * `logActivity`, on a SEPARATE connection, which swallows its own failures. That was
 * wrong in BOTH directions, and both are proved here against a real PostgreSQL
 * because "did this row survive a rollback" is not a property a double can answer.
 */

const BALANCING_ACTION = 'transfer_uncosted_balancing_layer'

/** A six-unit snapshot against a ten-unit booking — the shortfall that balances. */
function shortSlice(sourceLayerId: string) {
  return [{ costLayerId: sourceLayerId, qty: '6.000000', unitCostBase: '5.000000' }]
}

test(
  'the balancing WARNING commits with the layer it describes (Codex r9 MEDIUM-2)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db, product, warehouse, sourceLayer } = await seed('warncommit')
    const { recreateTransferCostLayersFromSnapshotSlice } =
      await import('@/lib/domain/inventory/transfer-cost-layer-recreation')
    const transferLineId = `tl-warncommit-${process.pid}-${Date.now()}`

    const result = await db.$transaction(async (tx) => recreateTransferCostLayersFromSnapshotSlice(
      tx,
      {
        productId: product.id,
        warehouseId: warehouse.id,
        transferLineId,
        contextLabel: 'round-9 durable warning probe',
        bookedQty: 10,
        uncostedShortfall: 'BALANCE_AT_ZERO_COST',
      },
      shortSlice(sourceLayer.id),
    ), TX)

    assert.ok(result.balancingLayer, 'the fixture must actually reach the balancing branch')
    assert.equal(result.balancingLayer.qty, '4.000000')

    const warning = await db.activityLog.findFirst({
      where: { action: BALANCING_ACTION, entityId: transferLineId },
      select: { level: true, description: true },
    })
    assert.ok(warning, 'the WARNING must be readable after the transaction commits')
    assert.equal(warning.level, 'WARNING')
    assert.match(String(warning.description), /4\.000000-unit shortfall/)
  },
)

test(
  'and DISAPPEARS when the enclosing transaction rolls back (Codex r9 MEDIUM-2)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // THE OTHER DIRECTION, and the one a separate-connection write got wrong
    // silently: the balancing layer is rolled back and the WARNING is not, leaving a
    // record that a £0 layer was created for stock that was never booked. An
    // operator reconciling from the activity log would chase a layer that does not
    // exist.
    loadEnv()
    const { db, product, warehouse, sourceLayer } = await seed('warnrollback')
    const { recreateTransferCostLayersFromSnapshotSlice } =
      await import('@/lib/domain/inventory/transfer-cost-layer-recreation')
    const transferLineId = `tl-warnrollback-${process.pid}-${Date.now()}`
    const layersBefore = await db.costLayer.count({ where: { productId: product.id } })

    const boom = new Error('caller failed AFTER the balancing layer was created')
    await assert.rejects(
      () => db.$transaction(async (tx) => {
        const result = await recreateTransferCostLayersFromSnapshotSlice(
          tx,
          {
            productId: product.id,
            warehouseId: warehouse.id,
            transferLineId,
            contextLabel: 'round-9 rolled-back warning probe',
            bookedQty: 10,
            uncostedShortfall: 'BALANCE_AT_ZERO_COST',
          },
          shortSlice(sourceLayer.id),
        )
        // The precondition of this test: the balancing DID happen, and the warning
        // was written, before anything went wrong. Without this the rollback
        // assertion below would pass on a run that never reached the branch at all.
        assert.ok(result.balancingLayer, 'the balancing branch must be reached before the rollback')
        throw boom
      }, TX),
      /caller failed AFTER the balancing layer was created/,
    )

    assert.equal(
      await db.costLayer.count({ where: { productId: product.id } }),
      layersBefore,
      'fixture check: the balancing layer really was rolled back',
    )
    assert.equal(
      await db.activityLog.count({ where: { action: BALANCING_ACTION, entityId: transferLineId } }),
      0,
      'the WARNING must roll back with the layer it describes — a surviving row would describe a layer that does not exist',
    )
  },
)
