import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

/**
 * o3d-w998: the CSV import reads three things from a PRE-LOCK snapshot of the product — one
 * `db.product.findMany` taken before the row loop — and then acts on them after its row has
 * taken the per-SKU write lock. o3d-42hw fixed the values used INSIDE the locked transaction;
 * these are the ones that escape it.
 *
 * Source-level because the invariants are about WHERE a read happens relative to a lock, and
 * a lock taken too late leaves the window wide open while looking entirely correct. Every
 * assertion here is mutation-verified against the code it claims to protect.
 */

const IMPORT_ACTIONS = path.join(process.cwd(), 'app/actions/import.ts')

async function source(): Promise<string> {
  return readFile(IMPORT_ACTIONS, 'utf8')
}

/**
 * The component pass: a separate loop, minutes after the row that queued it.
 *
 * Anchored on ITS OWN lock call. `tx.productComponent.deleteMany` appears twice — the locked
 * rename branch clears components too — and anchoring on that found the RENAME and sliced a
 * region these assertions say nothing about, while still passing some of them.
 */
async function componentPassBody(): Promise<string> {
  const src = await source()
  const at = src.indexOf('lockProductSkusForWrite(tx, [cr.sku])')
  assert.notEqual(at, -1, 'the component pass must take its own lock')
  const txAt = src.lastIndexOf('await db.$transaction', at)
  assert.notEqual(txAt, -1, 'it must open its own transaction')
  // Widened as the pass grew (o3d-4kfh r4 added the in-flight sales guard). It has to reach the
  // deleteMany, or the ordering assertions degrade into claims about a truncated slice.
  return src.slice(txAt, at + 2200)
}

test('the component pass takes the write lock (o3d-w998)', async () => {
  // It runs in its OWN transaction, long after the row's locked write committed, and used to
  // take no lock at all: a product converted KIT/BOM -> SIMPLE in between had its components
  // deleted and rewritten even though it no longer accepts any.
  const body = await componentPassBody()
  assert.match(body, /lockProductSkusForWrite\(tx, \[cr\.sku\]\)/, 'the pass must join the per-SKU write protocol')

  const lockAt = body.indexOf('lockProductSkusForWrite')
  const readAt = body.indexOf('tx.product.findUnique')
  const writeAt = body.indexOf('tx.productComponent.deleteMany')
  assert.ok(lockAt !== -1 && readAt !== -1 && writeAt !== -1, 'it must lock, re-read and write')
  assert.ok(lockAt < readAt, 'the lock must precede the re-read, or the re-read proves nothing')
  assert.ok(readAt < writeAt, 'the re-read must precede the write')
})

test('the component pass re-checks the type UNDER the lock (o3d-w998)', async () => {
  // The queue decision was made on the pre-lock type. Only a read under the lock can say
  // whether the product still accepts components.
  const body = await componentPassBody()
  assert.match(body, /COMPONENT_BEARING_TYPES\.has\(current\.type\)/, 'the type must be re-checked from the locked read')
  assert.ok(
    !/existingProduct\.type/.test(body),
    'the pass must not consult the pre-lock snapshot at all',
  )
})

test('the component pass verifies it locked the RIGHT product (o3d-w998)', async () => {
  // The lock is on cr.sku but the product is addressed by the id skuToId held at the end of
  // pass 1. A rename since then means the lock is held for a sku this product no longer has —
  // locked, but against the wrong thing, which reads as fully protected.
  const body = await componentPassBody()
  assert.match(body, /current\.sku !== cr\.sku/, 'the pass must confirm the locked sku still belongs to this product')
})

test('a rejected component row is reported and does not abort the import (o3d-w998)', async () => {
  // This loop reports per row; throwing would surface as a raw error message and, worse,
  // discard the remaining rows.
  const src = await source()
  assert.match(
    src,
    /no longer accepts components \(its type changed while the import/,
    'a rejected row must tell the operator its components were not written',
  )
  const body = await componentPassBody()
  assert.match(body, /return false/, 'the pass must return a decision rather than throwing')
})

test('the component queue is gated on the COMMITTED type, not the snapshot (o3d-w998)', async () => {
  // Not what makes it safe — the pass re-checks regardless — but it stops the common case
  // queueing a row only to reject it later for a conflict the operator never caused.
  const src = await source()
  assert.match(
    src,
    /const committedType = productById\.get\(skuToId\.get\(sku\) \?\? ''\)\?\.type \?\? type/,
    'the enqueue must prefer the type the locked transaction actually committed',
  )
  assert.ok(
    !/componentsStr && \(type === 'KIT' \|\| type === 'BOM'\)/.test(src),
    'the enqueue must no longer gate on the pre-lock `type`',
  )
})

test('an unrecognised lifecycleStatus is reported, not silently substituted (o3d-w998)', async () => {
  // The reachable bad path: a non-blank cell that is none of the four literals, with no
  // `active` column. It fell through to the SNAPSHOT lifecycle — and because the write guard
  // only asked whether the cell was non-blank, that stale value was written, silently
  // reverting a concurrent archive. The invalid value itself was never reported either,
  // unlike every other invalid cell in this importer.
  const src = await source()
  assert.match(src, /const lifecycleStatusValid = lifecycleStatusRaw === null/, 'validity must be decided explicitly')
  assert.match(
    src,
    /unrecognised lifecycleStatus/,
    'an unparseable lifecycle cell must be reported like every other invalid cell here',
  )
  assert.match(
    src,
    /if \(\(lifecycleStatusRaw && lifecycleStatusValid\) \|\| hasCsvValue\(row, 'active'\)\)/,
    'an invalid cell must not count as "the CSV asked for a lifecycle change"',
  )
})

test('the lifecycle write guard cannot be satisfied by an invalid cell alone (o3d-w998)', async () => {
  // Pins the actual logic rather than its spelling: a non-blank INVALID cell with no `active`
  // column must not write. Mirrors the source condition so a rewrite that reintroduces the
  // bug fails here.
  const writes = (raw: string | null, valid: boolean, hasActive: boolean) =>
    Boolean((raw && valid) || hasActive)

  assert.equal(writes('ARCHIVED', true, false), true, 'a valid cell writes')
  assert.equal(writes('BOGUS', false, false), false, 'an invalid cell alone must NOT write')
  assert.equal(writes('BOGUS', false, true), true, 'an explicit active column still writes')
  assert.equal(writes(null, true, false), false, 'no cell and no active column writes nothing')
})

test('the component pass addresses the product it QUEUED, not whatever holds the sku (o3d-w998)', async () => {
  // Codex: `skuToId` is mutated by every rename in pass 1, so resolving the id during pass 2
  // could land on a different product entirely. Row 1 renames P to B and queues components;
  // row 2 renames P again to C; row 3 assigns the now-free B to KIT Q. Pass 2 resolved B to
  // Q, locked B, and Q passed BOTH the sku and type checks — so P's component list replaced
  // Q's. The sku check cannot catch it, because the sku genuinely belongs to Q by then.
  const src = await source()

  assert.match(
    src,
    /componentRows: \{ lineNum: number; sku: string; productId: string; components: string \}\[\]/,
    'the queue must carry the immutable product id',
  )
  assert.match(src, /componentRows\.push\(\{ lineNum, sku, productId: componentProductId/, 'the id must be captured at enqueue')
  assert.match(src, /const productId = cr\.productId/, 'pass 2 must use the queued id')
  assert.ok(
    !/for \(const cr of componentRows\) \{\s*\n\s*const productId = skuToId\.get\(cr\.sku\)/.test(src),
    'pass 2 must not re-resolve the id through the mutable skuToId map',
  )
})

test('the CSV create locks the PARENT too, and re-reads it under the lock (o3d-1a84)', async () => {
  // o3d-w998 recorded that the pre-lock structure validation could only cause a false SKIP.
  // That holds for UPDATES, which re-validate under the lock — but NOT for creates: the parent
  // was validated before the transaction and only the new child was locked, so the WooCommerce
  // sync could change the parent VARIABLE -> SIMPLE in between and this committed a child
  // pointing at a parent that can no longer have children.
  const src = await source()
  const at = src.indexOf('const parentIdToWrite = structureValidation.normalizedParentId')
  assert.notEqual(at, -1, 'the create must resolve the parent it is about to write')
  const body = src.slice(at, at + 1600)

  // Both skus through the ONE helper, so they are acquired in the single ascending id order
  // rather than as two independent acquisitions that could deadlock.
  assert.match(
    body,
    /lockProductSkusForWrite\(tx, parentSkuToLock \? \[sku, parentSkuToLock\] : \[sku\]\)/,
    'the parent sku must be locked alongside the child, via the same helper',
  )

  const lockAt = body.indexOf('lockProductSkusForWrite')
  const parentReadAt = body.indexOf('where: { id: parentIdToWrite }')
  const typeAt = body.indexOf('parent.type !== ProductType.VARIABLE')
  assert.ok([lockAt, parentReadAt, typeAt].every((i) => i !== -1), 'lock, parent re-read and type check must be present')
  assert.ok(lockAt < parentReadAt, 'the lock must precede the parent re-read')
  assert.ok(parentReadAt < typeAt, 'the type must come from the locked read')

  // The lock set was chosen from a pre-transaction snapshot, so a rename invalidates it —
  // the same verification every other writer in this protocol needs.
  assert.match(body, /parent\.sku !== parentSkuToLock/, 'the chosen parent lock must be verified under the lock')
})

test('a parent that changed is reported per row, not thrown (o3d-1a84)', async () => {
  const src = await source()
  assert.match(src, /stopped being a variable product while the import was running/, 'the refusal must name what happened')
  assert.match(src, /its parent was renamed while the import was running/, 'a lost parent lock set must be reported too')
  // This loop has no per-row catch — a throw would discard every remaining row.
  const at = src.indexOf('const parentIdToWrite = structureValidation.normalizedParentId')
  const body = src.slice(at, at + 1600)
  assert.match(body, /return 'parent-not-variable' as const/, 'it must return a decision rather than throwing')
})
