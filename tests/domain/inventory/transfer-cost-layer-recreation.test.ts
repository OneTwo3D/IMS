import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { consumeFifoLayers } from '@/lib/cost-layers'
import { recreateTransferCostLayersFromSnapshotSlice } from '@/lib/domain/inventory/transfer-cost-layer-recreation'

/**
 * 6oyu.19 / Codex round-2 HIGH-1 and round-4 HIGH (o3d-eiuo). Four paths rebuild cost
 * layers from a transfer's dispatch snapshot; two of them forgot to link the new
 * layer back to the layer it came from, which quietly removed the units from COGS
 * with nowhere for the landed-cost delta to go. These tests cover the fix's three
 * parts: the LINK is a postcondition of the shared helper (so no caller can forget
 * it), the QUANTITY is too (every caller increments stock before calling, so an entry
 * the helper declines is unlayered stock, not a reportable gap), and a census fails
 * if a fifth path open-codes the sequence again.
 *
 * The helper does NOT settle a revaluation that landed while the units were in
 * transit — that machinery was withdrawn from this branch (o3d-nrl4), so there are
 * no settlement tests here. See the contract on
 * STOCK_TRANSFER_SOURCE_LAYER_CONSUMPTION.IN_TRANSIT for what is still open.
 */

type Store = {
  layers: Map<string, { id: string; sourceLines: Array<Record<string, unknown>> }>
  sourceLines: Array<Record<string, unknown>>
  created: Array<Record<string, unknown>>
}

function createStore(sourceLayerHasProvenance: boolean): { store: Store; tx: unknown } {
  const store: Store = { layers: new Map(), sourceLines: [], created: [] }
  store.layers.set('layer-src', {
    id: 'layer-src',
    sourceLines: sourceLayerHasProvenance
      ? [{ sourceProductId: 'prod-parent', sourceCostLayerId: 'layer-grandparent', qty: 10, unitCostBase: 4, totalCostBase: 40 }]
      : [],
  })
  let seq = 0
  const tx = {
    costLayer: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = `layer-new-${++seq}`
        store.created.push({ id, ...data })
        store.layers.set(id, { id, sourceLines: [] })
        return { id }
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const layer = store.layers.get(where.id)
        if (!layer) return null
        return { receivedQty: 10, sourceLines: layer.sourceLines }
      },
      // The quantity postcondition RE-READS what was persisted rather than trusting
      // the helper's own tally, so an id it was handed for a layer that was never
      // written simply does not come back — which is the whole point.
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        store.created.filter((layer) => where.id.in.includes(layer.id as string)),
    },
    costLayerSourceLine: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        store.sourceLines.push(data)
        return data
      },
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        store.sourceLines.push(...data)
        return { count: data.length }
      },
      count: async ({ where }: { where: { costLayerId: string } }) =>
        store.sourceLines.filter((line) => line.costLayerId === where.costLayerId).length,
    },
  }
  return { store, tx }
}

const TARGET = {
  productId: 'prod-1',
  warehouseId: 'wh-dest',
  transferLineId: 'tl-1',
  contextLabel: 'transfer TR-1 receipt',
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

test('a negative-cost snapshot entry is LAID DOWN, so on-hand never exceeds layer qty (o3d-eiuo)', async () => {
  // Codex round-4 HIGH. This entry used to be skipped and counted, on the theory
  // that a negative unit cost is corrupt provenance. It is not: recalculateLandedCosts
  // distributes credit freight lines with no positivity filter, and
  // updateSnapshotsForCostLayerChange rewrites stock_transfer_lines.costLayerSnapshot
  // in place, so a credit note landing mid-transit turns a positive dispatch snapshot
  // negative. Every caller has ALREADY incremented stock by the time it calls here, so
  // the skip left unlayered stock that nothing reported.
  //
  // Assert the QUANTITIES, not the absence of a throw.
  const { store, tx } = createStore(false)

  const result = await recreateTransferCostLayersFromSnapshotSlice(
    tx as never,
    TARGET,
    [{ costLayerId: 'layer-src', qty: '10.000000', unitCostBase: '-1.000000' }],
  )

  const onHandIncrementedByCaller = 10
  const layerQty = store.created.reduce((sum, layer) => sum + Number(layer.receivedQty), 0)
  assert.equal(layerQty, onHandIncrementedByCaller, 'on-hand must equal Σ FIFO-layer qty — no unlayered stock')
  assert.equal(result.recreatedQty, '10.000000')
  assert.equal(result.negativeCostLayers, 1, 'the unusual valuation is recorded…')
  assert.equal(result.createdLayers.length, 1, '…but the layer is created, not declined')
  // The cost basis is PRESERVED, not written off to £0: a warehouse-to-warehouse move
  // must not revalue the units it moves, and the source layer already stands here.
  assert.equal(result.createdLayers[0].unitCostBase, '-1.000000')
  assert.equal(Number(store.created[0].unitCostBase), -1)
  // Still reachable by propagation — a negative layer is not exempt from the link.
  assert.equal(store.sourceLines.length, 1)
  assert.equal(store.sourceLines[0].sourceCostLayerId, 'layer-src')
})

test('a later FIFO consumption of a negative-cost transfer layer values it correctly (o3d-eiuo)', async () => {
  // Where the harm of the old skip actually landed. With the layer missing, on-hand
  // stood 10 above Σ layer qty and a later consumption of those units either failed
  // (consumeFifoLayersStrict) or fell back to another layer's cost. Drive the REAL
  // FIFO consumer over the layer this helper now writes and assert the value.
  const { store, tx } = createStore(false)
  await recreateTransferCostLayersFromSnapshotSlice(
    tx as never,
    TARGET,
    [{ costLayerId: 'layer-src', qty: '10.000000', unitCostBase: '-1.000000' }],
  )
  assert.equal(store.created.length, 1, 'precondition: the transfer layer exists to be consumed')

  // A minimal FIFO store seeded from the layers the helper actually created, driven
  // by the REAL consumer so the valuation is the production one.
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
  assert.equal(consumption.consumed.length, 1, 'the transfer layer is the one consumed')
  assert.equal(consumption.consumed[0].qty.toString(), '4')
  assert.equal(
    consumption.consumed[0].unitCostBase.toString(),
    '-1',
    'valued at the basis it was transferred with, not silently at £0',
  )
  assert.equal(consumption.totalCost.toString(), '-4', 'the credit that made the layer negative reaches COGS, not nowhere')
  assert.equal(layers[0].remainingQty, '6', 'and the layer is drawn down, so on-hand and Σ layer qty stay equal')

  // The negative control: this is what the skipped entry left behind. Same 10 units
  // on hand (the caller incremented stock either way), no layer — FIFO comes back 4
  // short and values the consumption at nothing.
  const unlayered = await consumeFifoLayers(fifoTxFor([]) as never, 'prod-1', 'wh-dest', 4)
  assert.equal(unlayered.remainingQty.toString(), '4', 'precondition: unlayered stock is exactly a FIFO shortfall')
  assert.equal(unlayered.totalCost.toString(), '0')
})

test('the quantity postcondition FAILS if an entry is not laid down (o3d-eiuo)', async () => {
  // Proof the guard is not vacuous. The tests above would all pass with the
  // postcondition deleted, because their entries are created. This one reaches the
  // guard with a real shortfall: the injected creator drops the second entry, exactly
  // the shape the old negative-cost skip had — stock already incremented by the
  // caller, one entry's worth of units left with no layer.
  const { store, tx } = createStore(false)

  await assert.rejects(
    () => recreateTransferCostLayersFromSnapshotSlice(
      tx as never,
      TARGET,
      [
        { costLayerId: 'layer-src', qty: '6.000000', unitCostBase: '5.000000' },
        { costLayerId: 'layer-src', qty: '4.000000', unitCostBase: '-1.000000' },
      ],
      {
        createCostLayer: (async (client: unknown, data: { qty: unknown; unitCostBase: unknown }) => {
          // Skip the negative entry, as the withdrawn behaviour did, while still
          // handing back an id — the shape that made the old skip invisible.
          if (Number(String(data.unitCostBase)) < 0) return 'layer-skipped'
          // Mirrors the real createCostLayer's qty -> receivedQty/remainingQty mapping,
          // so the re-read the postcondition performs sees a truthful row.
          return (tx as { costLayer: { create: (args: unknown) => Promise<{ id: string }> } })
            .costLayer.create({ data: { ...data, receivedQty: String(data.qty), remainingQty: String(data.qty) } })
            .then((layer) => layer.id)
        }) as never,
        copyCostLayerSourceLinesProportionally: (async () => 0) as never,
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

test('no caller describes the helper as SETTLING a deferred transit reclass (Codex r4 LOW)', () => {
  // The helper creates propagation links. It persists and posts nothing that was
  // previously stranded, and the in-transit landed-cost gap (o3d-nrl4) is still open.
  // Three call-site comments claimed otherwise — a maintainer told the gap is handled
  // when it is not will not go looking for it.
  //
  // The rule is about the GRAMMAR OF THE CLAIM, not about proximity to a correction:
  // "settles the/any/those <something>" is an affirmative claim of settlement wherever
  // it appears, while "settles NOTHING" and "settles no deferred reclass" are not.
  const AFFIRMATIVE_SETTLEMENT = /\bsettle[sd]?\s+(?:the|any|its|those|these|same|all)\b/i

  const files = SCAN_ROOTS.flatMap((root) => walkTypeScript(root))
    .filter((file) => readFileSync(file, 'utf8').includes('recreateTransferCostLayersFromSnapshotSlice('))
    .sort()

  // Precondition: the walk actually reached the call sites. A census over an empty
  // set passes while examining nothing.
  assert.deepEqual(
    files,
    [
      'app/actions/transfers.ts',
      'lib/connectors/mintsoft/sync/stock-sync.ts',
      'lib/domain/inventory/transfer-cost-layer-recreation.ts',
      'lib/domain/wms/booked-in-service.ts',
    ],
    'the set of files mentioning the helper changed — a new one must also not claim settlement',
  )

  const offenders: string[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const [index, line] of source.split('\n').entries()) {
      if (AFFIRMATIVE_SETTLEMENT.test(line)) {
        offenders.push(`${file}:${index + 1}: ${line.trim()}`)
      }
    }
    assert.ok(
      source.includes('o3d-nrl4'),
      `${file}: must name the still-open in-transit gap rather than leaving the reader to assume it is handled`,
    )
  }

  assert.deepEqual(
    offenders,
    [],
    `the helper settles nothing — it only creates propagation links:\n${offenders.join('\n')}`,
  )
})
