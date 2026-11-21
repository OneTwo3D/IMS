/**
 * The #1119 review follow-ups folded into the lifecycle review work, each pinned by a test that fails without the fix:
 *   - MED-1: NON_INVENTORY products take their own WooCommerce status in the apply loop, so a conflict on one blocks (it used to be a non-blocking
 *     WARNING saying no lifecycle depends on it), and one WooCommerce does not hold is listed in LIFECYCLE_NOT_FROM_WOO like a simple, KIT or BOM;
 *   - (a) LIFECYCLE_NOT_FROM_WOO no longer says "not supplied" when woo-product-status was supplied but refused;
 *   - (b) LIFECYCLE_WOO_STATUS_UNUSABLE names the dataset the status came from;
 *   - (e) LIFECYCLE_WOO_STATUS_CONFLICT does not speak of "the bound snapshot" when there is none;
 *   - #1119 R1 L5: the snapshot check "the variable products in the product list are the parents" refuses a mismatch.
 * Synthetic data only.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { snapshotProblems, type SnapshotPayload } from '../../lib/first-load/snapshot.ts'
import { ds, findingCodes, product, rowsOf, run, runBare } from './helpers.ts'

const lifecycleOf = (r: ReturnType<typeof run>, sku: string): string => rowsOf(r, 'products').find((row) => row.sku === sku)?.lifecycleStatus ?? '(no row)'
const finding = (r: ReturnType<typeof run>, code: string) => r.report.findings.find((f) => f.code === code)

// [mutation: usesStatus counts SIMPLE/KIT/BOM only again]
test('MED-1: a NON_INVENTORY product takes its own Woo status, so a conflicting status on it BLOCKS like a simple product, and is not called unused', () => {
  const lone = run({ products: ds('products', [product('NI-1', 'NON_INVENTORY', { lifecycleStatus: 'ACTIVE' })]), 'woo-products': ds('woo-products', [{ sku: 'NI-1', status: 'draft' }]) })
  assert.equal(lifecycleOf(lone, 'NI-1'), 'DRAFT', 'precondition: the apply loop gives NON_INVENTORY its Woo status')
  const conflict = run({ products: ds('products', [product('NI-1', 'NON_INVENTORY', { lifecycleStatus: 'ACTIVE' })]), 'woo-products': ds('woo-products', [{ sku: 'NI-1', status: 'publish' }, { sku: 'NI-1', status: 'private' }]) })
  assert.equal(finding(conflict, 'LIFECYCLE_WOO_STATUS_CONFLICT')?.severity, 'ERROR')
  assert.deepEqual(finding(conflict, 'LIFECYCLE_WOO_STATUS_CONFLICT')?.keys, ['NI-1'])
  assert.equal(finding(conflict, 'LIFECYCLE_WOO_STATUS_CONFLICT_UNUSED'), undefined)
  assert.equal(conflict.blocking, true)
})

// [mutation: the absent list keeps only SIMPLE/KIT/BOM]
test('MED-1: a NON_INVENTORY product WooCommerce does not hold is listed in LIFECYCLE_NOT_FROM_WOO', () => {
  const r = run({ products: ds('products', [product('NI-1', 'NON_INVENTORY'), product('S-1', 'SIMPLE')]), 'woo-product-status': ds('woo-product-status', [{ sku: 'S-1', status: 'publish' }]) })
  assert.deepEqual(finding(r, 'LIFECYCLE_NOT_FROM_WOO')?.keys, ['NI-1'])
  assert.match(finding(r, 'LIFECYCLE_NOT_FROM_WOO')!.message, /simple, KIT, BOM or NON_INVENTORY/)
})

// [mutation: sourceNote ignores productStatusSummary.supplied]
test('(a) LIFECYCLE_NOT_FROM_WOO says woo-product-status was REFUSED, not "not supplied", when it was supplied unbound', () => {
  const refused = runBare({ products: ds('products', [product('S-1', 'SIMPLE')]), 'woo-product-status': ds('woo-product-status', [{ sku: 'S-1', status: 'draft' }]) }, {}, undefined, { verified: false, problems: ['synthetic: not verified'] })
  assert.ok(findingCodes(refused, 'ERROR').includes('PRODUCT_STATUS_NOT_BOUND'), 'precondition: the dataset was refused')
  const msg = finding(refused, 'LIFECYCLE_NOT_FROM_WOO')!.message
  assert.match(msg, /woo-product-status dataset was supplied but REFUSED/)
  assert.doesNotMatch(msg, /no WooCommerce status was supplied/)
  const none = run({ products: ds('products', [product('S-1', 'SIMPLE')]) })
  assert.match(finding(none, 'LIFECYCLE_NOT_FROM_WOO')!.message, /no WooCommerce status was supplied/, 'the not-supplied wording stays for a run without it')
})

// [mutation: LIFECYCLE_WOO_STATUS_UNUSABLE is attributed to woo-products whatever the source]
test('(b) LIFECYCLE_WOO_STATUS_UNUSABLE names the dataset the unusable status came from', () => {
  const fromSnapshot = run({ products: ds('products', [product('S-1', 'SIMPLE')]), 'woo-product-status': ds('woo-product-status', [{ sku: 'S-1', status: 'future' }]) })
  assert.deepEqual(fromSnapshot.report.findings.filter((f) => f.code === 'LIFECYCLE_WOO_STATUS_UNUSABLE').map((f) => [f.dataset, f.keys]), [['woo-product-status', ['S-1: ACTIVE, unmapped WooCommerce status "future"']]])
  const both = run({
    products: ds('products', [product('S-1', 'SIMPLE'), product('S-2', 'SIMPLE')]),
    'woo-product-status': ds('woo-product-status', [{ sku: 'S-1', status: 'future' }]),
    'woo-products': ds('woo-products', [{ sku: 'S-2', status: 'trash' }]),
  })
  assert.deepEqual(both.report.findings.filter((f) => f.code === 'LIFECYCLE_WOO_STATUS_UNUSABLE').map((f) => f.dataset).sort(), ['woo-product-status', 'woo-products'])
})

// [mutation: the conflict message always says "the bound snapshot does not state one"]
test('(e) the conflict wording names what is missing: no snapshot, a refused one, or a bound one that does not state the SKU', () => {
  const dup = [{ sku: 'S-1', status: 'publish' }, { sku: 'S-1', status: 'private' }]
  const noSnapshot = run({ products: ds('products', [product('S-1', 'SIMPLE')]), 'woo-products': ds('woo-products', dup) })
  assert.match(finding(noSnapshot, 'LIFECYCLE_WOO_STATUS_CONFLICT')!.message, /no woo-product-status snapshot was supplied to decide it/)
  assert.doesNotMatch(finding(noSnapshot, 'LIFECYCLE_WOO_STATUS_CONFLICT')!.message, /bound snapshot/)
  const bound = run({ products: ds('products', [product('S-1', 'SIMPLE')]), 'woo-products': ds('woo-products', dup), 'woo-product-status': ds('woo-product-status', [{ sku: 'OTHER', status: 'publish' }]) })
  assert.match(finding(bound, 'LIFECYCLE_WOO_STATUS_CONFLICT')!.message, /the bound snapshot does not state one/)
  const refused = runBare({ products: ds('products', [product('S-1', 'SIMPLE')]), 'woo-products': ds('woo-products', dup), 'woo-product-status': ds('woo-product-status', [{ sku: 'OTHER', status: 'publish' }]) }, {}, undefined, { verified: false, problems: ['synthetic'] })
  assert.match(finding(refused, 'LIFECYCLE_WOO_STATUS_CONFLICT')!.message, /woo-product-status dataset was refused \(not bound\)/)
})

// [mutation: the "variable products are the parents" comparison in snapshotProblems is removed]
test('#1119 R1 L5: a snapshot whose variable products are not exactly its parents is refused', () => {
  const payload: SnapshotPayload = {
    source: 'woocommerce',
    products: [{ id: 1, sku: 'P', name: 'P', type: 'variable', status: 'publish', manageStock: false, stockQuantity: null }, { id: 2, sku: 'Q', name: 'Q', type: 'variable', status: 'publish', manageStock: false, stockQuantity: null }],
    parents: [{ id: 1, sku: 'P', name: 'P', status: 'publish', variationIds: [] }],
    variations: [],
  }
  assert.deepEqual(snapshotProblems(payload), ['the variable products in the product list [1, 2] are not the parents [1]'])
  assert.deepEqual(snapshotProblems({ ...payload, products: payload.products.slice(0, 1) }), [], 'the control: equal lists are fine')
})
