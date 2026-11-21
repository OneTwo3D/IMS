/**
 * A SYNTHETIC first load for the owner lifecycle review tests: a fake WooCommerce store on 127.0.0.1 (snapshotted by the real snapshot command), a
 * native Qoblex products and stock export read through a column map, one sku-rename, and a fake WMS listing. Nothing here contacts a real host.
 *
 *   SKU (IMS)   Qoblex                    WooCommerce                     WMS (fake)               why it matters
 *   SIM-PUB     Active, MIL1 5            publish, stock 7                SIM-PUB active, 5        not reviewed; stock
 *   SIM-DRAFT   Active                    draft, stock 0, formula name    SIM-DRAFT active, 0      reviewed (Woo draft)
 *   SIM-PRIV    Archived, MIL1 0          private, stock not managed      SIM-PRIV active, 0       reviewed (both); no stock
 *   NEW-ARCH    Archived, MIL1 3          publish, stock 2                NEW-ARCH active, 3       reviewed (Qoblex Archived); stock
 *   NEW-1       OLD-1 (renamed), Active   publish, stock 0                OLD-1 discontinued, 0    reviewed (WMS); pre-rename SKU in WMS
 *   VAR-PARENT  -                         variable, publish               -                        VARIABLE parent (Woo + IMS only)
 *   VAR-01      variant, Active           variation, publish              VAR-01 active, 0
 *   VAR-02      variant, Archived         variation, private              VAR-02 active, 0         reviewed; Woo stock not read
 *   case-1      Active                    CASE-1 publish                  case-1 active            case-only mismatch
 *   Q-ONLY      Inactive                  -                               -                        Qoblex name fallback
 *   -           -                         EXT-1 external draft            -                        Woo-only, reviewed, not decidable
 *   -           -                         -                               MS-ONLY discontinued, 4  WMS-only, reviewed, not decidable
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SNAPSHOT_EXIT_CODES, SNAPSHOT_FILE_NAMES } from '../../lib/first-load/spec.ts'
import { runSnapshotCli } from '../../lib/first-load/woo-snapshot/cli.ts'
import type { WmsListing } from '../../lib/first-load/lifecycle-review/model.ts'
import { startFakeCatalogue } from '../helpers/fake-woocommerce-catalogue.ts'

export const KEY = 'ck_test_readonly_key_0000'
export const SECRET = 'cs_test_readonly_secret_1111'
export const FORMULA_NAME = '=cmd|" /c calc"!A1'

export const ATTESTED = {
  allProducts: { publish: 5, draft: 2, private: 1, pending: 0 },
  products: { publish: 1, draft: 0, private: 0, pending: 0 },
  variations: { publish: 1, draft: 0, private: 1, pending: 0 },
}

export const QOBLEX_PRODUCTS = [
  'Product,Sku,State,Product Type',
  'Simple published,SIM-PUB,Active,simple',
  'Simple draft (Qoblex name),SIM-DRAFT,Active,simple',
  'Simple private,SIM-PRIV,Archived,simple',
  'New but archived,NEW-ARCH,Archived,simple',
  'Old spelling,OLD-1,Active,simple',
  'Mug red,VAR-01,Active,variable',
  'Mug blue,VAR-02,Archived,variable',
  'Case product,case-1,Active,simple',
  'Only in Qoblex,Q-ONLY,Inactive,simple',
].join('\r\n') + '\r\n'

export const QOBLEX_STOCK = [
  'Sku,Warehouse,Quantity,Cost',
  'SIM-PUB,MIL1,5,1.50',
  'SIM-PRIV,MIL1,0,1.00',
  'NEW-ARCH,MIL1,3,2.00',
  'VAR-02,CAMB,0,0.80',
].join('\r\n') + '\r\n'

export const QOBLEX_MAP = {
  formatVersion: 1,
  source: 'qoblex',
  datasets: {
    products: {
      columns: { sku: 'Sku', name: 'Product', type: 'Product Type', lifecycleStatus: 'State' },
      valueMaps: { type: { simple: 'SIMPLE', variable: 'VARIANT' }, lifecycleStatus: { Active: 'ACTIVE', Inactive: 'EOL', Archived: 'DRAFT' } },
    },
    'stock-lots': { columns: { sku: 'Sku', warehouseCode: 'Warehouse', qty: 'Quantity', unitCost: 'Cost' }, constants: { currency: 'GBP' } },
  },
}

/** The WMS as the fake reports it (the SKU exactly as held, the physical stock summed over its warehouses). */
export function fakeWms(): WmsListing {
  const products: WmsListing['products'] = [
    { sku: 'SIM-PUB', productId: '11', status: 'active' },
    { sku: 'SIM-DRAFT', productId: '12', status: 'active' },
    { sku: 'SIM-PRIV', productId: '13', status: 'active' },
    { sku: 'NEW-ARCH', productId: '14', status: 'active' },
    { sku: 'OLD-1', productId: '15', status: 'discontinued' },
    { sku: 'VAR-01', productId: '16', status: 'active' },
    { sku: 'VAR-02', productId: '17', status: 'active' },
    { sku: 'case-1', productId: '18', status: 'active' },
    { sku: 'MS-ONLY', productId: '19', status: 'discontinued' },
  ]
  return { products, physical: new Map([['SIM-PUB', 5], ['NEW-ARCH', 3], ['MS-ONLY', 4]]), warehouses: ['5'] }
}

export interface Fixture {
  root: string
  /** A fresh, not-yet-existing path under the fixture root. */
  fresh: (label: string) => string
  manifestPath: string
  manifest: Record<string, unknown>
  /** Writes a manifest (the base one, changed by `change`) and returns its path. */
  writeManifest: (change?: (m: Record<string, unknown>) => void) => string
  cleanup: () => void
}

export async function buildFixture(): Promise<Fixture> {
  const root = mkdtempSync(path.join(tmpdir(), 'first-load-lifecycle-review-'))
  let counter = 0
  const fresh = (label: string) => path.join(root, `${label}-${++counter}`)
  const saved = process.env.E2E_TEST_MODE
  process.env.E2E_TEST_MODE = '1'
  const server = await startFakeCatalogue({
    key: KEY, secret: SECRET,
    parents: [{ id: 100, sku: 'VAR-PARENT', name: 'Mug', status: 'publish', variations: [{ id: 1001, sku: 'VAR-01', attributes: [{ name: 'Colour', option: 'Red' }] }, { id: 1002, sku: 'VAR-02', status: 'private', attributes: [{ name: 'Colour', option: 'Blue' }] }] }],
    products: [
      { id: 201, sku: 'SIM-PUB', name: 'Simple published (Woo)', status: 'publish', manage_stock: true, stock_quantity: 7 },
      { id: 202, sku: 'SIM-DRAFT', name: FORMULA_NAME, status: 'draft', manage_stock: true, stock_quantity: 0 },
      { id: 203, sku: 'SIM-PRIV', name: 'Simple private (Woo)', status: 'private' },
      { id: 204, sku: 'NEW-ARCH', name: 'New product (Woo)', status: 'publish', manage_stock: true, stock_quantity: 2 },
      { id: 205, sku: 'NEW-1', name: 'New spelling (Woo)', status: 'publish', manage_stock: true, stock_quantity: 0 },
      { id: 206, sku: 'CASE-1', name: 'Case product (Woo)', status: 'publish' },
      { id: 207, sku: 'EXT-1', name: 'External draft', type: 'external', status: 'draft' },
    ],
  })
  const snapshotDir = path.join(root, 'woo')
  try {
    const envFile = path.join(root, 'woo.env')
    writeFileSync(envFile, `FIRST_LOAD_WOO_URL=${server.url}\nFIRST_LOAD_WOO_KEY=${KEY}\nFIRST_LOAD_WOO_SECRET=${SECRET}\n`, { mode: 0o600 })
    chmodSync(envFile, 0o600)
    let stderr = ''
    const code = await runSnapshotCli(['--env-file', envFile, '--out', snapshotDir, '--allow-origin', server.origin, '--min-interval-ms', '0'], { stdout: () => {}, stderr: (s) => (stderr += s) })
    assert.equal(code, SNAPSHOT_EXIT_CODES.OK, stderr)
  } finally {
    await server.close()
    if (saved === undefined) delete process.env.E2E_TEST_MODE
    else process.env.E2E_TEST_MODE = saved
  }
  const qoblex = path.join(root, 'qoblex')
  mkdirSync(qoblex)
  writeFileSync(path.join(qoblex, 'products.csv'), QOBLEX_PRODUCTS)
  writeFileSync(path.join(qoblex, 'stock.csv'), QOBLEX_STOCK)
  writeFileSync(path.join(qoblex, 'qoblex.map.json'), JSON.stringify(QOBLEX_MAP))
  writeFileSync(path.join(qoblex, 'sku-renames.csv'), 'fromSku,toSku,reason\r\nOLD-1,NEW-1,Woo spelling (synthetic)\r\n')
  const manifest: Record<string, unknown> = {
    formatVersion: 1,
    baseCurrency: 'GBP',
    wooSnapshot: { snapshot: path.join(snapshotDir, SNAPSHOT_FILE_NAMES.snapshot), provenance: path.join(snapshotDir, SNAPSHOT_FILE_NAMES.provenance), origin: server.origin, visibilityChecked: ATTESTED },
    inputs: [
      { dataset: 'products', file: 'qoblex/products.csv', columnMap: 'qoblex/qoblex.map.json' },
      { dataset: 'stock-lots', file: 'qoblex/stock.csv', columnMap: 'qoblex/qoblex.map.json' },
      { dataset: 'sku-renames', file: 'qoblex/sku-renames.csv' },
      { dataset: 'variant-parents', file: path.join(snapshotDir, SNAPSHOT_FILE_NAMES.variantParents) },
      { dataset: 'woo-product-status', file: path.join(snapshotDir, SNAPSHOT_FILE_NAMES.productStatus) },
    ],
  }
  const writeManifest = (change?: (m: Record<string, unknown>) => void): string => {
    const m = structuredClone(manifest)
    change?.(m)
    const target = path.join(root, `manifest-${++counter}.json`)
    writeFileSync(target, JSON.stringify(m, null, 2))
    return target
  }
  return { root, fresh, manifest, manifestPath: writeManifest(), writeManifest, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
