import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

/**
 * Source guards (the actions need a live db, so the wiring is asserted on the source, like tests/products/bom-recipe.test.ts).
 * The values themselves are covered behaviourally in production-order-fx.test.ts.
 */
async function read(rel: string): Promise<string> {
  return readFile(path.join(process.cwd(), rel), 'utf8')
}

function body(src: string, start: string, end: string): string {
  const from = src.indexOf(start)
  assert.ok(from >= 0, `missing ${start}`)
  const to = src.indexOf(end, from)
  assert.ok(to > from, `missing ${end}`)
  return src.slice(from, to)
}

// [mutation: delete the spread in createManufacturingOrder's productionOrder.create data]
test('createManufacturingOrder writes the resolved currency + rate into create.data and the activity metadata', async () => {
  const src = await read('app/actions/manufacturing.ts')
  const fn = body(src, 'export async function createManufacturingOrder', "return { success: true, id: orderId }")
  const create = body(fn, 'tx.productionOrder.create', 'select: { id: true }')
  assert.match(create, /\.\.\.productionOrderFxCreateData\(fx, baseCurrency\)/)
  const activity = body(fn, 'await logActivity', "revalidatePath('/manufacturing')")
  assert.match(activity, /\.\.\.productionOrderFxActivityMetadata\(fx\)/)
  assert.match(fn, /resolveProductionOrderFx\(db, \{[\s\S]*?expectedFxRate: input\.expectedFxRate/)
})

test('cost-line edits pass the stored Decimal rate, not Number()', async () => {
  const src = await read('app/actions/manufacturing.ts')
  assert.match(src, /parseManufacturingCostLines\(lines, po\.fxRateToBase\)/)
  assert.doesNotMatch(src, /parseManufacturingCostLines\([^)]*Number\(/)
})

// [mutation: drop the currency from the reorder create data / select]
test('createReorderMOs inherits the latest order currency through resolveProductionOrderFx and skips on a refusal', async () => {
  const src = await read('app/actions/forecasting.ts')
  const fn = body(src, 'export async function createReorderMOs', 'return { success: true, moCount, skipped }')
  assert.match(fn, /select: \{ outputProductId: true, warehouseId: true, manufacturerId: true, currency: true \}/)
  assert.match(fn, /resolveProductionOrderFx\(db, \{ currency: latest\?\.currency, baseCurrency/)
  assert.match(fn, /if \(!fx\.ok\) \{[\s\S]*?fx_rate_unavailable[\s\S]*?continue/)
  assert.match(fn, /\.\.\.productionOrderFxCreateData\(fx, baseCurrency\)/)
})
