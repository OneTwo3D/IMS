import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { resolveProductSkuLockIds } from '@/lib/products/sku-write-lock'

/**
 * o3d-42hw. An advisory lock is COOPERATIVE: it serializes only the writers that take it.
 * o3d-uh2/o3d-fsi gave the per-SKU lock to the WooCommerce product-write transaction, but
 * the manual create, the variant create, the product editor and the CSV import all ran a
 * check-then-create with no lock, so the protection covered one writer out of five.
 *
 * The behaviour under real concurrency is proved in
 * tests/concurrency/product-sku-write-lock.concurrent.test.ts, which needs a live Postgres.
 * What is asserted HERE is the part that silently rots without a database: that every writer
 * still takes the lock, and takes it BEFORE the read it then relies on. A lock acquired
 * after the lookup reopens exactly the window it exists to close, and nothing about the
 * resulting code looks wrong.
 */

const PRODUCTS_ACTIONS = path.join(process.cwd(), 'app/actions/products.ts')
const IMPORT_ACTIONS = path.join(process.cwd(), 'app/actions/import.ts')
const WC_PRODUCT_SYNC = path.join(process.cwd(), 'lib/connectors/woocommerce/sync/product-sync.ts')

test('lock ids are deduplicated and ascending, whatever order the SKUs arrive in', async () => {
  // Sorting the IDS rather than the SKUs is the deadlock-freedom argument: two payloads
  // whose SKU sets overlap must request their shared ids in the same sequence.
  const calls: string[][] = []
  const client = {
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const skus = values[0] as string[]
      calls.push(skus)
      // Deliberately returned in an order that disagrees with the sorted one.
      return skus.map((sku, index) => ({ lock_id: (skus.length - index) * 10 }))
    },
  }

  const ids = await resolveProductSkuLockIds(client, ['b', 'a', 'b', 'c'])
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'ids must come back ascending')
  assert.deepEqual(calls[0], ['b', 'a', 'c'], 'duplicate SKUs must be collapsed before hashing')
})

test('an empty or blank SKU set takes no locks at all', async () => {
  let queried = false
  const client = {
    $queryRaw: async () => {
      queried = true
      return []
    },
  }
  assert.deepEqual(await resolveProductSkuLockIds(client, []), [])
  assert.deepEqual(await resolveProductSkuLockIds(client, ['']), [])
  assert.equal(queried, false, 'a no-op must not round-trip to the database')
})

/**
 * Each entry names a writer and the read it must not perform before locking. Source-level
 * because the invariant has to hold for writers added later too, and because the failure
 * mode — lock present but acquired too late — is invisible in a passing behavioural test.
 */
const WRITERS = [
  { file: PRODUCTS_ACTIONS, label: 'manual product create' },
  { file: PRODUCTS_ACTIONS, label: 'product editor' },
  { file: PRODUCTS_ACTIONS, label: 'variant generation' },
  { file: IMPORT_ACTIONS, label: 'CSV import' },
]

test('every Product.sku writer takes the write lock (o3d-42hw)', async () => {
  const sources = new Map<string, string>()
  for (const { file } of WRITERS) {
    if (!sources.has(file)) sources.set(file, await readFile(file, 'utf8'))
  }

  for (const [file, source] of sources) {
    assert.match(
      source,
      /lockProductSkusForWrite\(/,
      `${path.basename(file)} creates or renames Product.sku and must join the write protocol`,
    )
  }

  // The WooCommerce sync must keep taking the SAME namespace, or the two families of writer
  // contend with nobody. It resolves its ids up front (hashtext is pure) rather than through
  // the shared helper, which is why this checks the namespace instead of the helper name.
  const wcSource = await readFile(WC_PRODUCT_SYNC, 'utf8')
  assert.match(
    wcSource,
    /pg_advisory_xact_lock\(\$\{WC_PRODUCT_WRITE_LOCK_NAMESPACE\}::int4/,
    'the WC sync must stay on the shared namespace, or it serializes against nothing',
  )
})

test('every writer locks BEFORE the read it relies on (o3d-42hw)', async () => {
  // The ordering failure is the dangerous one: a lock taken after the lookup leaves the
  // check-then-create window wide open while looking, in review, entirely correct.
  const source = await readFile(PRODUCTS_ACTIONS, 'utf8')

  // Manual create: lock, then the re-check, then the create.
  const createStart = source.indexOf('created = await db.$transaction')
  assert.notEqual(createStart, -1, 'the manual create transaction must still exist')
  const createBody = source.slice(createStart, createStart + 1400)
  const lockAt = createBody.indexOf('lockProductSkusForWrite')
  const recheckAt = createBody.indexOf('tx.product.findUnique')
  const insertAt = createBody.indexOf('tx.product.create')
  assert.ok(lockAt !== -1 && recheckAt !== -1 && insertAt !== -1, 'create must lock, re-check and insert')
  assert.ok(lockAt < recheckAt, 'the lock must precede the re-check, or the re-check proves nothing')
  assert.ok(recheckAt < insertAt, 'the re-check must precede the insert')

  // Editor: lock, then the re-validation, then the update.
  const editStart = source.indexOf('updatedCategoryChange = await db.$transaction')
  assert.notEqual(editStart, -1, 'the editor transaction must still exist')
  const editBody = source.slice(editStart, editStart + 2000)
  const editLockAt = editBody.indexOf('lockProductSkusForWrite')
  const revalidateAt = editBody.indexOf('validateProductStructureChange')
  assert.ok(editLockAt !== -1 && revalidateAt !== -1, 'the editor must lock and re-validate')
  assert.ok(editLockAt < revalidateAt, 'the lock must precede the re-validation')
})

test('the editor writes the RE-VALIDATED structure, not the pre-transaction one (o3d-42hw)', async () => {
  // The worse half of the defect: structure was validated before the transaction and then
  // `type` / `parentId` written unconditionally, so a WooCommerce import committing in
  // between was overwritten with a decision made against a state that no longer existed.
  const source = await readFile(PRODUCTS_ACTIONS, 'utf8')
  const editStart = source.indexOf('updatedCategoryChange = await db.$transaction')
  const editBody = source.slice(editStart, source.indexOf('await logActivity', editStart))

  assert.ok(
    !editBody.includes('structureValidation.'),
    'the editor transaction must not read the pre-transaction validation result — it is stale by construction',
  )
  assert.match(editBody, /revalidated\.normalizedParentId/, 'parentId must come from the re-validation')
  assert.match(editBody, /revalidated\.clearExternalMapping/, 'the mapping-clear decision must come from the re-validation')
})

test('the CSV import skips a contended row instead of aborting the run (o3d-42hw)', async () => {
  // This loop has no per-row catch, so a throw would discard every remaining row over one
  // contended SKU.
  const source = await readFile(IMPORT_ACTIONS, 'utf8')
  // The CALL site, not the import statement at the top of the file — searching for the bare
  // name found the import and sliced 600 characters of unrelated imports.
  const lockAt = source.indexOf('lockProductSkusForWrite(tx,')
  assert.notEqual(lockAt, -1, 'the CSV import must take the write lock')
  const body = source.slice(lockAt, lockAt + 600)
  assert.match(body, /if \(taken\) return null/, 'a contended row must return, not throw')
  assert.match(
    source,
    /another writer created this SKU while the import was running/,
    'the skipped row must be reported to the operator rather than silently dropped',
  )
})
