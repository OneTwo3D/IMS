import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { recreateTransferCostLayersFromSnapshotSlice } from '@/lib/domain/inventory/transfer-cost-layer-recreation'

/**
 * 6oyu.19 / Codex round-2 HIGH-1. Four paths rebuild cost layers from a transfer's
 * dispatch snapshot; two of them forgot to link the new layer back to the layer it
 * came from, which quietly removed the units from COGS with nowhere for the
 * landed-cost delta to go. These tests cover the two halves of the fix: the link is
 * a POSTCONDITION of the shared helper (so no caller can forget it), and a census
 * that fails if a fifth path open-codes the sequence again.
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

test('a negative-cost snapshot entry is counted, never silently swallowed (6oyu.19)', async () => {
  // Corrupt provenance must not be capitalised, but the quantity gap it leaves has
  // to be visible to the caller (the manual receipt path turns it into a £0
  // balancing layer). Reported rather than inferred from a length mismatch.
  const { store, tx } = createStore(false)

  const result = await recreateTransferCostLayersFromSnapshotSlice(
    tx as never,
    TARGET,
    [{ costLayerId: 'layer-src', qty: '10.000000', unitCostBase: '-1.000000' }],
  )

  assert.equal(result.skippedNegativeCostEntries, 1)
  assert.equal(result.createdLayers.length, 0)
  assert.equal(store.created.length, 0)
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
