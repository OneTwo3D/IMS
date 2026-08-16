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
/**
 * Every Product.sku create-or-rename site, and how many acquisitions each FILE must show.
 *
 * Counting matters. An earlier version of this test asserted only that each file mentioned
 * the helper once, so deleting the variant lock, the editor lock, or leaving the CSV rename
 * path unprotected all still passed — which is exactly how the CSV rename got missed in the
 * first place (Codex review).
 */
const WRITERS = [
  {
    file: PRODUCTS_ACTIONS,
    // saveProductComponents is not a sku create/rename, but it takes the same lock for the
    // same reason (o3d-t0zq): its type check must serialize against the writers that CHANGE
    // that type, and those hold only the per-SKU lock.
    sites: ['manual product create', 'product editor', 'variant generation', 'component save'],
  },
  {
    file: IMPORT_ACTIONS,
    // The component pass is a Product-structure writer rather than a sku create/rename, but
    // it takes the same lock for the same reason (o3d-w998): it writes ProductComponent rows
    // long after the row that queued it committed, so it must re-check under the lock that
    // the product still accepts components.
    sites: ['CSV create', 'CSV rename/update', 'CSV component pass'],
  },
]

test('every Product.sku writer takes the write lock (o3d-42hw)', async () => {
  for (const { file, sites } of WRITERS) {
    const source = await readFile(file, 'utf8')
    // Call sites only — the import statement at the top of the file is not a writer.
    const acquisitions = source.match(/lockProductSkusForWrite\(tx,/g) ?? []
    assert.equal(
      acquisitions.length,
      sites.length,
      `${path.basename(file)} has ${sites.length} Product.sku create/rename sites `
        + `(${sites.join('; ')}) and must take the lock in each: found ${acquisitions.length}`,
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

test('the CSV rename path re-validates structure under its locks (o3d-42hw)', async () => {
  // It can rename an existing product AND writes type/parentId unconditionally, so it has
  // both halves of the defect the editor had.
  const source = await readFile(IMPORT_ACTIONS, 'utf8')
  const renameAt = source.indexOf('lockProductSkusForWrite(tx, [sku, existingProduct.sku])')
  assert.notEqual(renameAt, -1, 'the CSV rename must lock BOTH the old and the new sku')
  // o3d-4kfh r5: widened because the KIT-ness guard now sits between the re-validation and the
  // write. The window must still END inside this transaction, or the assertions below could be
  // satisfied by an unrelated later block.
  const body = source.slice(renameAt, renameAt + 4600)

  assert.match(body, /validateProductStructureChange\(/, 'the rename must re-validate under the locks')
  assert.match(body, /client: tx/, 'the re-validation must run against tx, or it re-reads pre-lock state')
  assert.match(body, /revalidated\.normalizedParentId/, 'the write must use the re-validated result')
  assert.ok(
    !body.includes('structureValidation.'),
    'the rename transaction must not read the pre-transaction validation — it is stale by construction',
  )
  assert.match(body, /conflict: 'moved' as const/, 'a lock set chosen against a stale sku must abandon')
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
  // Window sized generously on purpose: too tight and indexOf returns -1, which trips the
  // existence assertion rather than silently passing — but widening beats re-tuning it on
  // every edit.
  const editBody = source.slice(editStart, editStart + 3200)
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
  // The CREATE site specifically. The bare helper name matches the import statement at the top
  // of the file, and `(tx,` matches the RENAME site first — both windowed the wrong region.
  // Anchored on a marker unique to the create branch rather than on the lock call's exact
  // argument list, which o3d-1a84 changed when it added the parent sku.
  const lockAt = source.indexOf('const parentIdToWrite = structureValidation.normalizedParentId')
  assert.notEqual(lockAt, -1, 'the CSV create must still resolve the parent it writes')
  const body = source.slice(lockAt, lockAt + 1600)
  assert.match(body, /lockProductSkusForWrite\(tx,/, 'the CSV create must take the write lock')
  assert.match(body, /if \(taken\) return null/, 'a contended row must return, not throw')
  assert.match(
    source,
    /another writer created this SKU while the import was running/,
    'the skipped row must be reported to the operator rather than silently dropped',
  )
})

test('the editor VERIFIES its lock set once the locks are held (o3d-42hw)', async () => {
  // Which locks to take depends on the product's current sku, and reading that is itself
  // unprotected. A concurrent rename between the read and the acquisition leaves the editor
  // holding the lock for a sku the product no longer has — locked, but against the wrong
  // thing, which reads as fully protected. It cannot be fixed by moving the read after the
  // first acquisition: ascending-id order is what keeps the multi-lock case deadlock-free.
  const source = await readFile(PRODUCTS_ACTIONS, 'utf8')
  const editStart = source.indexOf('updatedCategoryChange = await db.$transaction')
  const editBody = source.slice(editStart, editStart + 2400)

  const lockAt = editBody.indexOf('lockProductSkusForWrite')
  const verifyAt = editBody.indexOf('skuUnderLock')
  assert.notEqual(verifyAt, -1, 'the editor must re-read its sku once the locks are held')
  assert.ok(lockAt < verifyAt, 'the verification must happen AFTER the locks, or it verifies nothing')
  assert.match(
    editBody.slice(verifyAt, verifyAt + 400),
    /ProductStructureChangedError/,
    'a lock set chosen against a stale sku must abandon the attempt, not proceed on a guess',
  )
})

test('the CSV rename defaults omitted columns from the LOCKED read, not the snapshot (o3d-42hw)', async () => {
  // The destructive one (Codex r2). An omitted CSV column means "preserve current". Taking
  // that current value from the pre-lock snapshot models a transformation the row never
  // asked for: a product that went SIMPLE -> KIT before the locks were taken gets validated
  // as a KIT -> SIMPLE conversion, and because updateData omits `type` the write leaves it
  // KIT while the resulting clearComponents / clearExternalMapping delete its components and
  // drop its external mapping.
  const source = await readFile(IMPORT_ACTIONS, 'utf8')
  const renameAt = source.indexOf('lockProductSkusForWrite(tx, [sku, existingProduct.sku])')
  const body = source.slice(renameAt, renameAt + 2600)

  const validateAt = body.indexOf('validateProductStructureChange(')
  assert.notEqual(validateAt, -1, 'the rename must re-validate under the locks')
  const inputs = body.slice(validateAt, validateAt + 400)

  assert.match(inputs, /\?\?\s*current\.type/, 'the type default must come from the locked read')
  assert.match(inputs, /\?\?\s*current\.parentId/, 'the parent default must come from the locked read')
  assert.ok(
    !/\?\?\s*existingProduct\./.test(inputs) && !inputs.includes('requestedParentId'),
    'no re-validation input may default to the pre-lock snapshot — that is the whole defect',
  )

  // The locked read has to actually select the columns those defaults use.
  const currentRead = body.slice(body.indexOf('const current = await tx.product.findUnique'), validateAt)
  assert.match(currentRead, /sku: true, type: true, parentId: true/, 'the locked read must select what the defaults need')
})

test('a concurrent writer performing THIS row\'s rename does not drop the row (o3d-42hw)', async () => {
  // The lock set covers both skus either way, so when another writer merely did the rename
  // this row wanted, proceeding is safe and dropping the row's other updates is not.
  const source = await readFile(IMPORT_ACTIONS, 'utf8')
  const renameAt = source.indexOf('lockProductSkusForWrite(tx, [sku, existingProduct.sku])')
  const body = source.slice(renameAt, renameAt + 1400)
  assert.match(
    body,
    /current\.sku !== existingProduct\.sku && current\.sku !== sku/,
    'a move TO this row\'s target sku must not be treated as a lost lock set',
  )
})

test('the in-run cache records what the locked transaction COMMITTED (o3d-42hw)', async () => {
  // The importer caches each product it touches so later rows in the same CSV can preflight
  // against it. Caching the PRE-LOCK projection meant a later row could validate against
  // structure that was never written — the locked defaults may preserve a concurrent
  // type/parent, so the projected values no longer describe the row (Codex review, r3).
  const source = await readFile(IMPORT_ACTIONS, 'utf8')
  const cacheAt = source.indexOf('productById.set(existingProduct.id, {')
  assert.notEqual(cacheAt, -1, 'the in-run product cache must still exist')
  const cache = source.slice(cacheAt, cacheAt + 800)

  assert.match(cache, /effectiveStructure\?\.type/, 'the cached type must prefer what was committed')
  assert.match(cache, /effectiveStructure \? effectiveStructure\.parentId/, 'the cached parent must prefer what was committed')

  // Preview runs no transaction, so it legitimately keeps the projected values — the
  // fallbacks must survive.
  assert.match(cache, /structureValidation\.normalizedParentId/, 'preview must still fall back to the projection')
})
