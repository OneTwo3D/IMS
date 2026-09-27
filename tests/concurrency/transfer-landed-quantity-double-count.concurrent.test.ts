import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'

/**
 * 6oyu.19 / Codex round-6 HIGH-1 — THE MONEY PROOF.
 *
 * THE SEQUENCE: a WMS stock-sync ALIGNMENT lands an IN_TRANSIT transfer's units at
 * the destination and lays their cost layers; the dispatch is then CANCELLED; a
 * landed-cost change is then applied to the layer they came from.
 *
 * THE DEFECT. The alignment credits `wms_asn_line_maps.qtyAccountedViaSnapshot` and
 * never touches `stock_transfer_lines.qtyReceived`. `cancelDispatchedTransfer` asked
 * `qtyReceived > 0`, saw zero, concluded nothing had arrived, restored the FULL line
 * quantity to source and created a SECOND replacement cost layer linked back to the
 * same source layer. Both layers are then live and both are reachable by
 * `propagateLandedCostToOutputs`, so ONE dispatch of ten units posts the inventory
 * reclassification for TWENTY.
 *
 * This test asserts the POSTED AMOUNT, not the absence of a throw: it runs the real
 * `propagateLandedCostToOutputs` over the state the real `cancelDispatchedTransfer`
 * leaves behind, and sums what it accumulates. Restore the old guard
 * (`lines.some((line) => Number(line.qtyReceived ?? 0) > 0)`) and this test reports
 * 20 where it requires 10.
 *
 * It needs a real PostgreSQL — the propagation walks `cost_layer_source_lines` in
 * SQL and the exclusion queries are raw jsonb containment.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const TX = { timeout: 20000, maxWait: 10000 }

// The server action is gated on a session and revalidates Next's cache; neither is
// the subject here. Everything that touches stock, cost layers or the two counters
// is the REAL code.
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {}, logActivityInTransaction: async () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/fulfillment/backorder-allocator', {
  namedExports: { allocateBackordersForProducts: async () => ({}) },
})
mock.module('@/lib/fulfillment/overallocation-rebalancer', {
  namedExports: { releaseOverallocations: async () => ({}) },
})

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  }
}

const LINE_QTY = 10
const UNIT_COST = 5
const LANDED_COST_DELTA_PER_UNIT = 1

/**
 * THE FIXTURE'S IDENTITY (o3d-kx1uy). `warehouses.code` is UNIQUE — and in the schema it is
 * plain TEXT (`prisma/schema.prisma` `code String @unique`, `CREATE TABLE "warehouses" ... "code"
 * TEXT NOT NULL`), so there is NO width the fixture has to fit and nothing to truncate to.
 *
 * WHAT WAS WRONG. The codes were `${tag.slice(0, 16)}S` / `...D` over
 * `tag = R6DC-${label}-${process.pid}-${Date.now()}`. Measured, with pid 934827:
 *
 *     tag              = R6DC-nothing-934827-1790446129914
 *     tag.slice(0, 16) = R6DC-nothing-934          <-- Date.now() gone; 3 pid digits left
 *     codes            = R6DC-nothing-934S / R6DC-nothing-934D
 *
 * `R6DC-` plus the longest label plus its hyphens already spends 13 of the 16 characters, so the
 * timestamp NEVER survived and most of the pid did not either: the code was effectively
 * `R6DC-<label>-<floor(pid/1000)>`. These fixtures are never deleted, so a second tier run against
 * the same scratch database whose pid merely shares its leading digits asks for a code that is
 * already there and `db.warehouse.create()` fails with
 * `Unique constraint failed on the fields: (code)`. Two agents hit it in 1 of 5 full-tier runs
 * each. The sibling file `transfer-cost-layer-recreation-context.concurrent.test.ts` carries the
 * same finding in its own words after the same failure.
 *
 * WHAT IS DIFFERENT NOW. The identity comes from `randomUUID()` — unique by construction, not by
 * a clock and not by a pid — it is NOT truncated, and it is placed at the START of the code, so a
 * future truncation removes the human-readable label rather than the entropy. `fixtureCodes()` is
 * the only place a code is built, and `the fixture identities are unique by construction` below
 * asserts both properties, so re-introducing a `.slice()` reds a test instead of producing an
 * intermittent CI failure.
 */
function fixtureCodes(label: string) {
  // 32 lowercase hex characters, no hyphens: unique by construction, and entropy-FIRST so that
  // every prefix of the identifier is still unique. Nothing here may be truncated or re-ordered.
  // Each identifier gets its OWN uid: sharing one would mean a truncation that keeps only the uid
  // still collapses the source and destination codes into each other.
  const uid = () => randomUUID().replace(/-/g, '')
  return {
    tag: `${uid()}-R6DC-${label}`,
    sourceCode: `${uid()}-R6DC-${label}-S`,
    destinationCode: `${uid()}-R6DC-${label}-D`,
  }
}

const FIXTURE_LABELS = ['inputs', 'money', 'nothing', 'manual'] as const

/**
 * THE REGRESSION GUARD for o3d-kx1uy. It needs no database, so it runs in `test:unit` too — a
 * truncation re-introduced into `fixtureCodes()` reds this test in the cheap tier instead of
 * failing one tier run in five with `Unique constraint failed on the fields: (code)`.
 *
 * It holds the CLOCK STILL and keeps the pid, which is what the old code depended on: with
 * `Date.now()` frozen and one process, the old `R6DC-${label}-${pid}-${Date.now()}`.slice(0, 16)
 * produced ONE code per label, forever. Uniqueness must survive that.
 *
 * WHAT WOULD STILL PASS IT, stated so nobody mistakes it for more than it is:
 *   · a `fixtureCodes()` that is unique and entropy-first but that `seedAlignedInTransitTransfer`
 *     stops using — the assertions are about the builder, not about the `create()` call sites. The
 *     seed helper therefore takes its codes from `fixtureCodes()` and builds none of its own; that
 *     coupling is reviewed, not asserted.
 *   · truncation applied to a code AFTER this function returns it (at the call site).
 *   · a different entropy source that is also 32 lowercase hex characters and also unique — which
 *     is the point: the properties are pinned, not the implementation.
 * It would NOT pass if the entropy were truncated, moved off the front, or replaced by anything
 * derived from the clock or the pid.
 */
test('the fixture identities are unique by construction, entropy first (o3d-kx1uy)', () => {
  const ROUNDS = 500
  const realNow = Date.now
  const codes: string[] = []
  try {
    Date.now = () => 1790446129914 // frozen: the old tag's only entropy, held still
    for (let i = 0; i < ROUNDS; i += 1) {
      for (const label of FIXTURE_LABELS) {
        const { sourceCode, destinationCode } = fixtureCodes(label)
        codes.push(sourceCode, destinationCode)
      }
    }
  } finally {
    Date.now = realNow
  }

  // The precondition, printed so a vacuous run is visible: the loop really generated codes.
  const expected = ROUNDS * FIXTURE_LABELS.length * 2
  assert.equal(codes.length, expected, `generated ${codes.length} codes, expected ${expected}`)
  console.log(`# o3d-kx1uy guard: examined ${codes.length} generated warehouse codes`)

  // 1. Unique, with the clock frozen and the pid fixed.
  assert.equal(
    new Set(codes).size,
    expected,
    'two fixture warehouse codes collided with the clock frozen — the identity depends on time or pid again',
  )

  // 2. Entropy FIRST and NOT truncated: 32 hex characters, then the human-readable part. A
  //    `.slice()` anywhere in fixtureCodes() breaks this for every code at once.
  for (const code of codes) {
    assert.match(
      code,
      /^[0-9a-f]{32}-R6DC-(inputs|money|nothing|manual)-[SD]$/,
      `fixture warehouse code "${code}" must start with 32 untruncated hex characters of entropy`,
    )
  }

  // 3. The property the old code lacked: the uniqueness lives in the PREFIX, so truncating the
  //    code from the right — which is what `.slice(0, n)` does — cannot remove it. Checked at the
  //    narrowest prefix that still carries the whole identity, and at a few shorter ones.
  for (const width of [32, 33, 40]) {
    assert.equal(
      new Set(codes.map((code) => code.slice(0, width))).size,
      expected,
      `truncating every fixture code to ${width} characters collapsed it — entropy is not at the front`,
    )
  }
})

/**
 * Build the state the WMS stock-sync alignment leaves behind for a fully-aligned,
 * still-IN_TRANSIT transfer line.
 *
 * The destination layer is created by the REAL shared helper
 * (`recreateTransferCostLayersFromSnapshotSlice`) and the ASN counter is incremented
 * exactly as `applyMintsoftAlignmentForProduct` does — those two writes are the whole
 * of what the alignment leaves behind that matters here. The alignment itself cannot
 * be driven from a test: it is reached only through `runStockSyncForBinding`, which
 * calls the LIVE Mintsoft API.
 */
async function seedAlignedInTransitTransfer(label: string) {
  const { db } = await import('@/lib/db')
  const { recreateTransferCostLayersFromSnapshotSlice } =
    await import('@/lib/domain/inventory/transfer-cost-layer-recreation')

  const { tag, sourceCode, destinationCode } = fixtureCodes(label)
  const product = await db.product.create({
    data: { sku: tag, name: `r6 double-count ${label}`, type: 'SIMPLE', countryOfOrigin: 'CN' },
    select: { id: true },
  })
  const source = await db.warehouse.create({
    data: { code: sourceCode, name: `${tag} source`, type: 'STANDARD' },
    select: { id: true },
  })
  const destination = await db.warehouse.create({
    data: { code: destinationCode, name: `${tag} dest`, type: 'STANDARD' },
    select: { id: true },
  })

  // The source layer, as dispatch left it: consumed (remainingQty 0), with the
  // dispatch snapshot frozen on the transfer line.
  const sourceLayer = await db.costLayer.create({
    data: {
      productId: product.id,
      warehouseId: source.id,
      receivedQty: `${LINE_QTY}.000000`,
      remainingQty: '0.000000',
      unitCostBase: UNIT_COST,
    },
    select: { id: true },
  })
  const snapshot = [{ costLayerId: sourceLayer.id, qty: `${LINE_QTY}.000000`, unitCostBase: `${UNIT_COST}.000000` }]

  const transfer = await db.stockTransfer.create({
    data: {
      reference: tag,
      fromWarehouseId: source.id,
      toWarehouseId: destination.id,
      status: 'IN_TRANSIT',
      dispatchedAt: new Date(),
      lines: {
        create: [{
          productId: product.id,
          sku: tag,
          productName: `r6 double-count ${label}`,
          qty: `${LINE_QTY}.0000`,
          qtyReceived: '0.0000',
          costLayerSnapshot: snapshot,
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const transferLineId = transfer.lines[0]!.id

  // The ASN the alignment credited against.
  const asn = await db.wmsAsnMap.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: 6oyu.19: a test fixture row, not a core flow branch
      externalAsnId: tag,
      sourceType: 'STOCK_TRANSFER',
      sourceId: transfer.id,
      warehouseId: destination.id,
      status: 'OPEN',
      lines: {
        create: [{
          externalAsnLineId: `${tag}-1`,
          sourceType: 'STOCK_TRANSFER_LINE',
          sourceLineId: transferLineId,
          productId: product.id,
          sku: tag,
          expectedQty: `${LINE_QTY}.0000`,
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const asnLineMapId = asn.lines[0]!.id

  // THE ALIGNMENT, as stock-sync.ts performs it: stock in at the destination, layers
  // rebuilt from the snapshot through the shared helper, and the credit recorded on
  // qtyAccountedViaSnapshot — with qtyReceived deliberately left alone, because the
  // alignment path never writes it. That omission is the finding.
  await db.$transaction(async (tx) => {
    await tx.stockLevel.create({
      data: { productId: product.id, warehouseId: destination.id, quantity: `${LINE_QTY}`, reservedQty: '0' },
    })
    await recreateTransferCostLayersFromSnapshotSlice(
      tx,
      {
        productId: product.id,
        warehouseId: destination.id,
        transferLineId,
        contextLabel: `transfer line ${transferLineId} WMS stock-sync alignment`,
        bookedQty: LINE_QTY,
        uncostedShortfall: 'REFUSE',
      },
      snapshot,
    )
    await tx.wmsAsnLineMap.update({
      where: { id: asnLineMapId },
      data: { qtyAccountedViaSnapshot: { increment: LINE_QTY } },
    })
  }, TX)

  return { db, product, source, destination, sourceLayer, transfer, transferLineId, asnLineMapId, tag }
}

/** The real propagation deps, assembled from the same modules production uses. */
async function landedCostDeps() {
  const costLayers = await import('@/lib/cost-layers')
  return {
    getReturnedQtyForCostLayer: costLayers.getReturnedQtyForCostLayer,
    getSupplierReturnedQtyForCostLayer: costLayers.getSupplierReturnedQtyForCostLayer,
    getManufacturingConsumedQtyForCostLayer: costLayers.getManufacturingConsumedQtyForCostLayer,
    getReversalConsumedQtyForCostLayer: costLayers.getReversalConsumedQtyForCostLayer,
    getTransferConsumedQtyForCostLayer: costLayers.getTransferConsumedQtyForCostLayer,
    getDependentOutputSourceLines: costLayers.getDependentOutputSourceLines,
    updateSnapshotsForCostLayerChange: costLayers.updateSnapshotsForCostLayerChange,
    refreshShipmentCogsForCostLayerChange: costLayers.refreshShipmentCogsForCostLayerChange,
    refreshSalesOrderLineCogsForCostLayerChange: costLayers.refreshSalesOrderLineCogsForCostLayerChange,
    recordCostLayerRevaluation: costLayers.recordCostLayerRevaluation,
    warnWeightFallback: () => undefined,
    warnWeightZeroLines: () => undefined,
  }
}

/**
 * Apply a retrospective per-unit landed-cost change to `sourceCostLayerId` and return
 * what the reclassification would post, per reached output layer. This is the real
 * `propagateLandedCostToOutputs`; the accumulator is the same callback shape the
 * recalc paths pass it.
 */
async function applyLandedCostChange(sourceCostLayerId: string) {
  const { db } = await import('@/lib/db')
  const { Prisma } = await import('@/app/generated/prisma/client')
  const { propagateLandedCostToOutputs } = await import('@/lib/domain/purchasing/landed-cost-service')
  const deps = await landedCostDeps()

  const posted: Array<{ outputCostLayerId: string; inventoryDelta: string; cogsDelta: string }> = []
  await db.$transaction(async (tx) => {
    await propagateLandedCostToOutputs(
      tx,
      deps as never,
      sourceCostLayerId,
      new Prisma.Decimal(LANDED_COST_DELTA_PER_UNIT),
      (cogsDelta, inventoryDelta, audit) => {
        posted.push({
          outputCostLayerId: audit.outputCostLayerId,
          inventoryDelta: inventoryDelta.toFixed(2),
          cogsDelta: cogsDelta.toFixed(2),
        })
      },
      new Set<string>(),
      0,
      `r6-proof-${Date.now()}`,
      new Date(),
    )
  }, TX)

  const totalInventory = posted.reduce((sum, row) => sum + Number(row.inventoryDelta), 0)
  return { posted, totalInventory }
}

test(
  'THE DEFECT, measured: the pre-fix cancellation inputs say "nothing landed" while ten units have (Codex r6 HIGH-1)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // The precondition the whole finding rests on, read off the real row rather than
    // asserted in prose. If this ever stopped holding, the guard change below would
    // be guarding nothing.
    loadEnv()
    const { db, transferLineId, destination, sourceLayer } = await seedAlignedInTransitTransfer('inputs')
    const { loadTransferLineLandedQty, requireLandedQty } =
      await import('@/lib/domain/inventory/transfer-landed-quantity')

    const line = await db.stockTransferLine.findUniqueOrThrow({
      where: { id: transferLineId },
      select: { id: true, qty: true, qtyReceived: true },
    })

    // THE OLD READER, verbatim from the pre-fix cancellation.
    assert.equal(Number(line.qtyReceived ?? 0) > 0, false, 'the pre-fix guard sees nothing landed')
    assert.equal(Number(line.qty) - Number(line.qtyReceived), LINE_QTY, 'and would restore the WHOLE line')

    // THE NEW READER, on the same row.
    const landed = requireLandedQty(await loadTransferLineLandedQty(db, [line]), line.id)
    assert.equal(landed.qtyNumber, LINE_QTY, 'ten units have in fact landed')
    assert.equal(landed.fromQtyReceived.toNumber(), 0, 'none of them through qtyReceived')
    assert.equal(landed.fromUnabsorbedWmsSnapshot.toNumber(), LINE_QTY, 'all of them through the WMS snapshot credit')

    // And they are really on the shelf, in a real layer, linked to the source.
    assert.equal(
      await db.costLayer.count({ where: { warehouseId: destination.id, remainingQty: { gt: 0 } } }),
      1,
    )
    assert.equal(
      await db.costLayerSourceLine.count({ where: { sourceCostLayerId: sourceLayer.id } }),
      1,
      'exactly one live layer descends from the source layer at this point',
    )
  },
)

test(
  'align → cancel dispatch → landed-cost change posts the reclassification ONCE (Codex r6 HIGH-1)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db, transfer, sourceLayer, source } = await seedAlignedInTransitTransfer('money')
    const { cancelDispatchedTransfer } = await import('@/app/actions/transfers')

    // STEP 2: cancel the dispatch. The units have landed, so this must refuse —
    // restoring them to source would put the same ten units in two warehouses and,
    // worse, give them a second live cost layer.
    const result = await cancelDispatchedTransfer(transfer.id)
    assert.match(
      String(result.message),
      /already been partly received/,
      `cancelling an aligned dispatch must be refused, got ${JSON.stringify(result)}`,
    )
    assert.notEqual(result.success, true)

    // Nothing was restored to source.
    assert.equal(
      await db.costLayer.count({ where: { warehouseId: source.id, remainingQty: { gt: 0 } } }),
      0,
      'the cancellation must not have created a replacement layer at source',
    )
    assert.equal(
      await db.costLayerSourceLine.count({ where: { sourceCostLayerId: sourceLayer.id } }),
      1,
      'still exactly ONE layer descends from the source layer',
    )

    // STEP 3: the landed-cost change. THE ASSERTION IS THE AMOUNT.
    const { posted, totalInventory } = await applyLandedCostChange(sourceLayer.id)

    assert.equal(
      posted.length,
      1,
      `the reclassification must reach exactly one layer, reached ${posted.length}: ${JSON.stringify(posted)}`,
    )
    assert.equal(
      totalInventory.toFixed(2),
      (LANDED_COST_DELTA_PER_UNIT * LINE_QTY).toFixed(2),
      `£${LANDED_COST_DELTA_PER_UNIT}/unit on ${LINE_QTY} dispatched units must post ` +
      `£${(LANDED_COST_DELTA_PER_UNIT * LINE_QTY).toFixed(2)} of inventory reclassification, not ` +
      `£${totalInventory.toFixed(2)} — a second live layer means the same units were revalued twice ` +
      `(${JSON.stringify(posted)})`,
    )
  },
)

test(
  'a transfer with NOTHING landed can still have its dispatch cancelled (Codex r6 — not vacuous)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // The refusal above must discriminate. Without this, changing the guard to
    // "always refuse" would pass every assertion in this file.
    loadEnv()
    const { db, product, transfer, sourceLayer, source, asnLineMapId } =
      await seedAlignedInTransitTransfer('nothing')
    // Undo the alignment credit and its layer, leaving a plain dispatched transfer.
    await db.costLayerSourceLine.deleteMany({ where: { sourceCostLayerId: sourceLayer.id } })
    // SCOPED TO THIS FIXTURE'S OWN PRODUCT (o3d-zjsb5.9 round 6). Without `productId`, this
    // predicate is database-wide: "every cost layer that is not mine, has no PO line, and is not in
    // my source warehouse" matches OTHER test files' layers in this shared-database tier, and
    // deleting one that a `cogs_entries` row points at raises
    // `cogs_entries_costLayerId_fkey`. That is not hypothetical -- it is reproducible: run
    // `bom-recipe-import.concurrent.test.ts` (which completes a production order, so it commits the
    // tier's first COGS-referenced `poLineId IS NULL` layers) to completion first, then this file,
    // and this test fails. In a parallel tier run it fails only when the delete loses that race,
    // which is how it arrived as an intermittent `not ok 145`.
    const removedAlignmentLayers = await db.costLayer.deleteMany({
      where: { productId: product.id, id: { not: sourceLayer.id }, poLineId: null, warehouseId: { not: source.id } },
    })
    // The scoping above narrowed this predicate, so prove it still MATCHES. A scope that matches
    // nothing would leave the alignment credit in place and quietly turn this test into a
    // different, easier one -- the failure mode of the fix, asserted rather than assumed.
    assert.ok(
      removedAlignmentLayers.count > 0,
      'the fixture must actually remove its own alignment layer, or this test no longer tests an un-landed dispatch',
    )
    await db.wmsAsnLineMap.update({ where: { id: asnLineMapId }, data: { qtyAccountedViaSnapshot: 0 } })

    const { cancelDispatchedTransfer } = await import('@/app/actions/transfers')
    const result = await cancelDispatchedTransfer(transfer.id)
    assert.equal(result.success, true, `an un-landed dispatch must still be cancellable, got ${JSON.stringify(result)}`)

    const cancelled = await db.stockTransfer.findUniqueOrThrow({
      where: { id: transfer.id },
      select: { status: true },
    })
    assert.equal(cancelled.status, 'CANCELLED')
    assert.equal(
      await db.costLayer.count({ where: { warehouseId: source.id, remainingQty: { gt: 0 } } }),
      1,
      'and the stranded units come back to source in exactly one replacement layer',
    )

    // The replacement layer is reachable, and the reclassification still posts once.
    const { posted, totalInventory } = await applyLandedCostChange(sourceLayer.id)
    assert.equal(posted.length, 1)
    assert.equal(totalInventory.toFixed(2), (LANDED_COST_DELTA_PER_UNIT * LINE_QTY).toFixed(2))
  },
)

test(
  'a MANUAL receipt after an alignment does not re-lay the aligned layers (Codex r6 HIGH-1, mirror)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // The same defect reached from the other side: the manual receipt path sliced the
    // dispatch snapshot from `qtyReceived`, which is zero for an aligned line, and so
    // re-created every layer the alignment had already laid down.
    loadEnv()
    const { db, transfer, sourceLayer, destination, transferLineId, asnLineMapId } =
      await seedAlignedInTransitTransfer('manual')
    const { receiveTransfer } = await import('@/app/actions/transfers')

    const result = await receiveTransfer(transfer.id)
    assert.equal(result.success, true, `receiving must succeed, got ${JSON.stringify(result)}`)

    assert.equal(
      await db.costLayer.count({ where: { warehouseId: destination.id } }),
      1,
      'the aligned units must NOT get a second destination layer',
    )
    assert.equal(
      await db.costLayerSourceLine.count({ where: { sourceCostLayerId: sourceLayer.id } }),
      1,
    )

    // And the landed total is still ten, not twenty: closing the line folded the
    // alignment credit into qtyReceived AND marked it absorbed, so the two counters
    // do not both claim the same units.
    const { loadTransferLineLandedQty, requireLandedQty } =
      await import('@/lib/domain/inventory/transfer-landed-quantity')
    const line = await db.stockTransferLine.findUniqueOrThrow({
      where: { id: transferLineId },
      select: { id: true, qtyReceived: true },
    })
    assert.equal(Number(line.qtyReceived), LINE_QTY, 'the line reads fully received')
    const asnRow = await db.wmsAsnLineMap.findUniqueOrThrow({
      where: { id: asnLineMapId },
      select: { qtyAccountedViaSnapshot: true, qtyAccountedViaReceipt: true },
    })
    assert.equal(Number(asnRow.qtyAccountedViaReceipt), LINE_QTY, 'and the WMS credit is marked absorbed')
    const landed = requireLandedQty(await loadTransferLineLandedQty(db, [line]), line.id)
    assert.equal(landed.qtyNumber, LINE_QTY, 'landed stays at ten — the counters do not double-count')

    const { posted, totalInventory } = await applyLandedCostChange(sourceLayer.id)
    assert.equal(posted.length, 1)
    assert.equal(totalInventory.toFixed(2), (LANDED_COST_DELTA_PER_UNIT * LINE_QTY).toFixed(2))
  },
)
