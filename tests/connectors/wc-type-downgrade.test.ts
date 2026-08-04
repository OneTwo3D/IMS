import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { planTypeWrite } from '@/lib/connectors/woocommerce/product-type-downgrade'

/**
 * o3d-t0zq part 2 / o3d-0hhu: WooCommerce distinguishes only `variable` from everything else,
 * so the sync mapped every non-variable product to SIMPLE and wrote it over whatever the local
 * type was. A KIT, a BOM or a VARIABLE parent therefore became SIMPLE while its ProductComponent
 * rows and VARIANT children stayed exactly where they were.
 *
 * The editor forbids that transformation outright. The sync ran none of its checks.
 */

const SKU = 'SKU-1'

test('a structured type with dependent rows is NOT downgraded (o3d-t0zq)', () => {
  for (const existingType of ['KIT', 'BOM', 'VARIABLE']) {
    const plan = planTypeWrite({ existingType, incomingType: 'SIMPLE', hasStructure: true, sku: SKU })
    assert.equal(plan.action, 'keep', `${existingType} with dependent rows must not become SIMPLE`)
    assert.equal(plan.type, existingType, 'the local type is kept')
    assert.ok(plan.action === 'keep')
    assert.match(plan.reason, /kept/, 'and the refusal must explain itself')
    assert.match(plan.reason, /Change the structure in IMS first/, 'and say how to proceed deliberately')
  }
})

test('the same type with NOTHING depending on it is rewritten freely (o3d-t0zq)', () => {
  // The entire reason to refuse is the orphaned rows. With none, refusing would just freeze a
  // stale type forever and make a legitimate WooCommerce change impossible to apply.
  for (const existingType of ['KIT', 'BOM', 'VARIABLE']) {
    assert.deepEqual(
      planTypeWrite({ existingType, incomingType: 'SIMPLE', hasStructure: false, sku: SKU }),
      { action: 'write', type: 'SIMPLE' },
    )
  }
})

test('upgrades and unrelated types are untouched (o3d-t0zq)', () => {
  // SIMPLE -> VARIABLE is how a product legitimately gains variants and must keep working.
  assert.deepEqual(
    planTypeWrite({ existingType: 'SIMPLE', incomingType: 'VARIABLE', hasStructure: false, sku: SKU }),
    { action: 'write', type: 'VARIABLE' },
  )
  // Even with structure: a SIMPLE product is not a structured type, so nothing is being stranded.
  assert.deepEqual(
    planTypeWrite({ existingType: 'SIMPLE', incomingType: 'VARIABLE', hasStructure: true, sku: SKU }),
    { action: 'write', type: 'VARIABLE' },
  )
  // A brand-new product has nothing to protect.
  assert.deepEqual(
    planTypeWrite({ existingType: null, incomingType: 'SIMPLE', hasStructure: false, sku: SKU }),
    { action: 'write', type: 'SIMPLE' },
  )
  // No change is not a downgrade.
  assert.deepEqual(
    planTypeWrite({ existingType: 'KIT', incomingType: 'KIT', hasStructure: true, sku: SKU }),
    { action: 'write', type: 'KIT' },
  )
})

test('the structure count runs under the SAME lock as the write (o3d-t0zq)', async () => {
  // A component or child added between an unlocked read and the update would be stranded by the
  // very check meant to prevent it — the lock-set verification this protocol has needed at every
  // other site.
  const source = await readFile(
    path.join(process.cwd(), 'lib/connectors/woocommerce/sync/product-sync.ts'),
    'utf8',
  )

  const txAt = source.indexOf('const { syncedProductId, syncedSku, tradeChanges, wasUpdate } = await db.$transaction')
  assert.notEqual(txAt, -1, 'the write transaction must still exist')
  const body = source.slice(txAt)

  const countAt = body.indexOf('tx.productComponent.count')
  const childAt = body.indexOf("tx.product.count({ where: { parentId: existing.id } })")
  const planAt = body.indexOf('planTypeWrite({')
  const writeAt = body.indexOf('type: typePlan.type')
  assert.ok([countAt, childAt, planAt, writeAt].every((i) => i !== -1), 'counts, plan and write must all be present')
  assert.ok(countAt < planAt && childAt < planAt, 'both counts must precede the decision')
  assert.ok(planAt < writeAt, 'and the decision must precede the write')

  // Counted through tx, not the module-level db — a different connection would read outside this
  // transaction's snapshot and outside the advisory lock it holds.
  assert.ok(
    !/db\.productComponent\.count/.test(body.slice(0, writeAt)),
    'the counts must go through the transaction client',
  )

  // The UPDATE branch must use the plan; the CREATE branch has no existing row to protect.
  assert.ok(!/type: productType,\s*\n\s*externalProductId: BigInt\(wcProduct\.id\),\s*\n\s*\}\s*\n\s*\n?\s*\/\/ Prices/.test(body),
    'the update branch must not write the raw incoming type')
})

test('a refused downgrade is recorded, not silently swallowed (o3d-t0zq)', async () => {
  // The operator changed the type in WooCommerce and it did not take. If nothing says so, the
  // sync looks successful and the product looks wrong for reasons nobody can trace.
  const source = await readFile(
    path.join(process.cwd(), 'lib/connectors/woocommerce/sync/product-sync.ts'),
    'utf8',
  )
  const at = source.indexOf("if (typePlan.action === 'keep')")
  assert.notEqual(at, -1, 'the refusal must be recorded')
  const body = source.slice(at, at + 900)
  assert.match(body, /tx\.activityLog\.create/, 'through the transaction, so record and refusal are one fact')
  assert.match(body, /action: 'wc_type_downgrade_refused'/)
  assert.match(body, /level: 'WARNING'/)
  assert.match(body, /keptType: typePlan\.type/, 'and must record what was kept')
  assert.match(body, /incomingType: productType/, 'and what was refused')
})

test('a refused type applies NONE of the shape-derived data (o3d-t0zq)', async () => {
  // The worst thing the first cut did: keep the local type while still nulling prices, creating
  // variations and writing options from the incoming shape. A kept KIT receiving a WooCommerce
  // `variable` would have had VARIATIONS CREATED BENEATH IT — the exact forbidden structure this
  // change exists to prevent, produced by the change itself (Codex review).
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const source = await readFile(
    path.join(process.cwd(), 'lib/connectors/woocommerce/sync/product-sync.ts'),
    'utf8',
  )

  assert.match(source, /const typeRefused = typePlan\.action === 'keep'/, 'the refusal must be a named condition')
  assert.match(source, /if \(isVariable && !typeRefused\)/, 'variations must not be applied under a refused type')
  assert.match(source, /if \(!typeRefused\) \{\s*\n\s*await applyProductOptions/, 'nor options')

  // Prices must be left alone entirely, not merely branched differently.
  const priceAt = source.indexOf('// Prices — only set on non-VARIABLE')
  const priceBlock = source.slice(priceAt, priceAt + 700)
  assert.match(priceBlock, /if \(typeRefused\)/, 'prices must be skipped on a refused type')
  assert.ok(
    !/if \(productType !== 'VARIABLE'\)/.test(priceBlock),
    'the price branch must use the EFFECTIVE type, not the rejected incoming one',
  )
})

test('the structure check covers every type-dependent row family (o3d-t0zq)', async () => {
  // ProductComponent and child products were the obvious two. A VARIABLE parent with options but
  // no children yet would still have become SIMPLE with its ProductOption rows stranded; and
  // BomItem/KitItem rows are read by replenishment and inventory-health only while the parent is
  // still BOM/KIT, so a product with those and no ProductComponent would drop out silently.
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const source = await readFile(
    path.join(process.cwd(), 'lib/connectors/woocommerce/sync/product-sync.ts'),
    'utf8',
  )
  const at = source.indexOf('let hasStructure = false')
  const body = source.slice(at, source.indexOf('const typePlan', at))

  for (const probe of [
    'tx.productComponent.count',
    'tx.product.count({ where: { parentId: existing.id } })',
    'tx.productOption.count',
    'tx.bomItem.count({ where: { parentProductId: existing.id } })',
    'tx.kitItem.count({ where: { parentProductId: existing.id } })',
  ]) {
    assert.ok(body.includes(probe), `${probe} must be counted`)
  }

  // And only when the type is actually changing — an unchanged VARIABLE product paid five
  // indexed counts per sync for nothing, which across a catalogue is thousands of statements
  // inside write transactions.
  assert.match(body, /existing\.type !== productType/, 'counts must be skipped when the type is unchanged')
})
