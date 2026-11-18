import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'
import { config } from 'dotenv'
import { NextResponse } from 'next/server'

/**
 * ORDER ATTACHMENTS AGAINST A REAL DATABASE AND A REAL (TEMP) UPLOAD DIRECTORY: the session is the only double. Proves cross-order access is refused, a
 * soft delete hides the file and its download, an erased order takes no new file, and a customer erasure deletes the sales-order attachments (rows and files)
 * and leaves purchase-order attachments alone.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

const uploadRoot = mkdtempSync(path.join(os.tmpdir(), 'oa-db-'))
process.env.UPLOAD_STORAGE_DIR = uploadRoot
const attachmentDir = path.join(uploadRoot, 'order-attachments')
const filesOnDisk = () => (existsSync(attachmentDir) ? readdirSync(attachmentDir).sort() : [])

let current: { user: { id: string; role: string } } | NextResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
let mocked = false
async function load() {
  if (!mocked) {
    const actual = await import('@/lib/auth/server')
    mock.module('@/lib/auth/server', { namedExports: { ...actual, requireApiAuth: async () => current } })
    mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } })
    mocked = true
  }
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { db } = await import('@/lib/db')
  const routes = await import('@/lib/order-attachment-routes')
  return { db, routes }
}
type Loaded = Awaited<ReturnType<typeof load>>

const PDF = (tag: string) => Buffer.from(`%PDF-1.4\n${tag}\n%%EOF\n`, 'latin1')
const createdUserIds: string[] = []
const as = async (db: Loaded['db'], role: string) => {
  const user = await db.user.create({ data: { email: `oa-${randomUUID()}@example.test`, name: 'Attachment Tester', passwordHash: 'x', role: role as never } })
  createdUserIds.push(user.id)
  current = { user: { id: user.id, role } }
  return user.id
}
function upload(bytes: Buffer, name: string): Request {
  const form = new FormData()
  form.append('file', new File([new Uint8Array(bytes)], name))
  return new Request('http://localhost/x', { method: 'POST', body: form })
}
const get = () => new Request('http://localhost/x')

async function seedOrders(db: Loaded['db']) {
  const supplier = await db.supplier.create({ data: { name: `OA Supplier ${randomUUID().slice(0, 8)}` } as never })
  const mkPo = () => db.purchaseOrder.create({ data: { reference: `OA-PO-${randomUUID().slice(0, 8)}`, supplierId: supplier.id, currency: 'GBP', fxRateToBase: 1, subtotalForeign: 1, subtotalBase: 1, totalForeign: 1, totalBase: 1 } as never })
  const mkSo = (customerId: string | null) => db.salesOrder.create({ data: { orderNumber: `OA-SO-${randomUUID().slice(0, 8)}`, status: 'PROCESSING', currency: 'GBP', customerId, customerName: 'Zebediah Quillfeather', customerEmail: `z-${randomUUID().slice(0, 8)}@example.test`, subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1 } as never })
  const customer = await db.customer.create({ data: { firstName: 'Zebediah', lastName: 'Quillfeather', email: `zq-${randomUUID().slice(0, 8)}@example.test` } })
  const po1 = await mkPo(); const po2 = await mkPo()
  const so1 = await mkSo(customer.id); const so2 = await mkSo(customer.id); const guest = await mkSo(null)
  return {
    supplier, customer, po1, po2, so1, so2, guest,
    async cleanup() {
      const soIds = [so1.id, so2.id, guest.id]
      await db.activityLog.deleteMany({ where: { entityId: { in: [po1.id, po2.id, ...soIds, customer.id] } } })
      await db.orderAttachment.deleteMany({ where: { OR: [{ purchaseOrderId: { in: [po1.id, po2.id] } }, { salesOrderId: { in: soIds } }] } })
      await db.salesOrder.deleteMany({ where: { id: { in: soIds } } })
      await db.purchaseOrder.deleteMany({ where: { id: { in: [po1.id, po2.id] } } })
      await db.customer.deleteMany({ where: { id: customer.id } })
      await db.supplier.deleteMany({ where: { id: supplier.id } })
    },
  }
}

test.after(async () => {
  rmSync(uploadRoot, { recursive: true, force: true })
  // THE SCRATCH-DATABASE GUARD REFUSES ANY LATER FILE ONCE public.users HOLDS A ROW (an "installed application"): remove every user this file created, and the queue rows.
  if (!RUN) return
  const { db } = await load()
  await db.orderAttachmentFileDeletion.deleteMany({})
  await db.activityLog.deleteMany({ where: { userId: { in: createdUserIds } } })
  await db.user.deleteMany({ where: { id: { in: createdUserIds } } })
})

test('[order attachments] upload stores the row and a randomly named file, lists, downloads as an attachment, and a soft delete hides both', { skip }, async (t) => {
  const { db, routes } = await load()
  const fx = await seedOrders(db)
  t.after(() => fx.cleanup())
  const userId = await as(db, 'ADMIN')
  const bytes = PDF('quote one')

  const up = await routes.handleUpload(upload(bytes, '../../Supplier quote.pdf'), { kind: 'purchase-orders', orderId: fx.po1.id })
  assert.equal(up.status, 201)
  const { id } = (await up.json()) as { id: string }
  const row = await db.orderAttachment.findUniqueOrThrow({ where: { id } })
  assert.equal(row.purchaseOrderId, fx.po1.id)
  assert.equal(row.salesOrderId, null)
  assert.equal(row.originalFilename, 'Supplier quote.pdf', 'the claimed path is stripped from the display name')
  assert.match(row.storedName, /^[0-9a-f-]{36}\.pdf$/, 'a random server-chosen name, not the claimed one')
  assert.equal(row.mimeType, 'application/pdf')
  assert.equal(row.byteSize, bytes.length)
  assert.equal(row.sha256.length, 64)
  assert.equal(row.uploadedByUserId, userId)
  assert.equal(row.deletedAt, null)
  assert.deepEqual(filesOnDisk(), [row.storedName])
  assert.equal((await db.activityLog.count({ where: { entityId: fx.po1.id, action: 'attachment_uploaded' } })), 1)
  assert.doesNotMatch(JSON.stringify(await db.activityLog.findMany({ where: { entityId: fx.po1.id } })), /Supplier quote/, 'the file name is not written to the activity log')

  const { listOrderAttachments } = await import('@/lib/domain/order-attachments')
  const listed = await listOrderAttachments('purchase', fx.po1.id)
  assert.deepEqual(listed.map((r) => [r.id, r.originalFilename, r.uploadedByName]), [[id, 'Supplier quote.pdf', 'Attachment Tester']])
  assert.deepEqual(await listOrderAttachments('purchase', fx.po2.id), [])

  const dl = await routes.handleDownload(get(), { kind: 'purchase-orders', orderId: fx.po1.id, id })
  assert.equal(dl.status, 200)
  assert.match(dl.headers.get('content-disposition') ?? '', /^attachment; filename="Supplier quote\.pdf"/)
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), bytes)

  // SOFT DELETE: the row stays (with deletedAt), the list and the download no longer show it, a second delete finds nothing.
  const del = await routes.handleDelete(get(), { kind: 'purchase-orders', orderId: fx.po1.id, id })
  assert.equal(del.status, 200)
  const after = await db.orderAttachment.findUniqueOrThrow({ where: { id } })
  assert.ok(after.deletedAt, 'soft deleted, not removed')
  assert.deepEqual(await listOrderAttachments('purchase', fx.po1.id), [], 'hidden from the list')
  assert.equal((await routes.handleDownload(get(), { kind: 'purchase-orders', orderId: fx.po1.id, id })).status, 404, 'the download now 404s')
  assert.equal((await routes.handleDelete(get(), { kind: 'purchase-orders', orderId: fx.po1.id, id })).status, 404, 'a second delete finds nothing')
  assert.equal((await db.activityLog.count({ where: { entityId: fx.po1.id, action: 'attachment_deleted' } })), 1)
})

test('[order attachments] cross-order access: an attachment id of another order (or order type) is not found for download or delete', { skip }, async (t) => {
  const { db, routes } = await load()
  const fx = await seedOrders(db)
  t.after(() => fx.cleanup())
  await as(db, 'ADMIN')
  const poUp = await routes.handleUpload(upload(PDF('po'), 'po.pdf'), { kind: 'purchase-orders', orderId: fx.po1.id })
  const soUp = await routes.handleUpload(upload(PDF('so'), 'so.pdf'), { kind: 'sales-orders', orderId: fx.so1.id })
  const poAtt = ((await poUp.json()) as { id: string }).id
  const soAtt = ((await soUp.json()) as { id: string }).id

  for (const [kind, orderId, id] of [
    ['purchase-orders', fx.po2.id, poAtt], // same type, another order
    ['sales-orders', fx.so2.id, soAtt],
    ['sales-orders', fx.po1.id, poAtt], // a purchase order's id under the sales route
    ['purchase-orders', fx.so1.id, soAtt],
    ['purchase-orders', fx.po1.id, soAtt], // the other type's attachment under the right order id
    ['sales-orders', fx.so1.id, poAtt],
    ['purchase-orders', fx.po1.id, '../../etc/passwd'],
    ['purchase-orders', fx.po1.id, 'does-not-exist'],
  ] as const) {
    assert.equal((await routes.handleDownload(get(), { kind, orderId, id })).status, 404, `download ${kind}/${orderId}/${id}`)
    assert.equal((await routes.handleDelete(get(), { kind, orderId, id })).status, 404, `delete ${kind}/${orderId}/${id}`)
  }
  assert.equal(await db.orderAttachment.count({ where: { id: { in: [poAtt, soAtt] }, deletedAt: null } }), 2, 'none of the refused deletes took effect')
  // CONTROL: the right order and type does work.
  assert.equal((await routes.handleDownload(get(), { kind: 'purchase-orders', orderId: fx.po1.id, id: poAtt })).status, 200)
  assert.equal((await routes.handleDownload(get(), { kind: 'sales-orders', orderId: fx.so1.id, id: soAtt })).status, 200)
})

test('[order attachments] denied callers leave no row and no file; a refused upload to a missing or erased order leaves no orphan file', { skip }, async (t) => {
  const { db, routes } = await load()
  const fx = await seedOrders(db)
  t.after(() => fx.cleanup())
  const before = filesOnDisk()

  current = NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  assert.equal((await routes.handleUpload(upload(PDF('x'), 'x.pdf'), { kind: 'sales-orders', orderId: fx.so1.id })).status, 401)
  await as(db, 'READONLY')
  assert.equal((await routes.handleUpload(upload(PDF('x'), 'x.pdf'), { kind: 'sales-orders', orderId: fx.so1.id })).status, 403)
  await as(db, 'SUPPLIER')
  assert.equal((await routes.handleUpload(upload(PDF('x'), 'x.pdf'), { kind: 'purchase-orders', orderId: fx.po1.id })).status, 403)
  await as(db, 'FINANCE') // purchasing.create but not sales.create / sales.process
  assert.equal((await routes.handleUpload(upload(PDF('x'), 'x.pdf'), { kind: 'sales-orders', orderId: fx.so1.id })).status, 403)
  assert.equal(await db.orderAttachment.count({ where: { OR: [{ purchaseOrderId: fx.po1.id }, { salesOrderId: fx.so1.id }] } }), 0)
  assert.deepEqual(filesOnDisk(), before)

  await as(db, 'ADMIN')
  assert.equal((await routes.handleUpload(upload(PDF('x'), 'x.pdf'), { kind: 'purchase-orders', orderId: 'no-such-order' })).status, 404)
  await db.salesOrder.update({ where: { id: fx.guest.id }, data: { erasedAt: new Date() } })
  assert.equal((await routes.handleUpload(upload(PDF('x'), 'x.pdf'), { kind: 'sales-orders', orderId: fx.guest.id })).status, 409, 'an erased order takes no new file')
  assert.deepEqual(filesOnDisk(), before, 'no orphan file from either refusal')
})

test('[order attachments] the row cannot name two parents or none (CHECK), and a deleted order takes its attachment rows', { skip }, async (t) => {
  const { db } = await load()
  const fx = await seedOrders(db)
  t.after(() => fx.cleanup())
  const base = { originalFilename: 'a.pdf', mimeType: 'application/pdf', byteSize: 1, sha256: 'x'.repeat(64), uploadedByUserId: 'u' }
  await assert.rejects(db.orderAttachment.create({ data: { ...base, storedName: `${randomUUID()}.pdf`, purchaseOrderId: fx.po1.id, salesOrderId: fx.so1.id } }), /order_attachments_one_parent|check constraint/i)
  await assert.rejects(db.orderAttachment.create({ data: { ...base, storedName: `${randomUUID()}.pdf` } }), /order_attachments_one_parent|check constraint/i)
  const ok = await db.orderAttachment.create({ data: { ...base, storedName: `${randomUUID()}.pdf`, purchaseOrderId: fx.po2.id } })
  await db.purchaseOrder.delete({ where: { id: fx.po2.id } })
  assert.equal(await db.orderAttachment.count({ where: { id: ok.id } }), 0, 'cascade with the order')
})

test('[order attachments] erasing a customer deletes the attachments of their sales orders (rows, soft-deleted rows and files), and leaves purchase-order attachments and other customers\' alone', { skip }, async (t) => {
  const { db, routes } = await load()
  const fx = await seedOrders(db)
  const other = await seedOrders(db)
  t.after(async () => { await fx.cleanup(); await other.cleanup() })
  await as(db, 'ADMIN')
  const put = async (kind: string, orderId: string, tag: string) => ((await (await routes.handleUpload(upload(PDF(tag), `${tag}.pdf`), { kind, orderId })).json()) as { id: string }).id
  const a1 = await put('sales-orders', fx.so1.id, 'customer po')
  const a2 = await put('sales-orders', fx.so2.id, 'proof of address')
  const a3 = await put('sales-orders', fx.so1.id, 'to be soft deleted')
  const poAtt = await put('purchase-orders', fx.po1.id, 'supplier quote')
  const otherAtt = await put('sales-orders', other.so1.id, 'someone else')
  await routes.handleDelete(get(), { kind: 'sales-orders', orderId: fx.so1.id, id: a3 })
  const names = async (ids: string[]) => (await db.orderAttachment.findMany({ where: { id: { in: ids } }, select: { storedName: true } })).map((r) => r.storedName)
  const erasedNames = await names([a1, a2, a3])
  const keptNames = await names([poAtt, otherAtt])
  assert.equal(erasedNames.length, 3)
  for (const n of [...erasedNames, ...keptNames]) assert.ok(filesOnDisk().includes(n), 'PRECONDITION: the file exists before the erasure')

  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const result = await eraseCustomerPersonalData(fx.customer.id, { trigger: 'ON_REQUEST', userId: null })
  assert.equal(result.success, true, JSON.stringify(result))

  assert.equal(await db.orderAttachment.count({ where: { id: { in: [a1, a2, a3] } } }), 0, 'rows deleted, the soft-deleted one included')
  for (const n of erasedNames) assert.ok(!filesOnDisk().includes(n), `file ${n} removed`)
  assert.equal(await db.orderAttachment.count({ where: { id: { in: [poAtt, otherAtt] } } }), 2, 'purchase-order and other-customer attachments untouched')
  for (const n of keptNames) assert.ok(filesOnDisk().includes(n), `file ${n} kept`)
  const record = await db.activityLog.findFirstOrThrow({ where: { entityType: 'CUSTOMER', entityId: fx.customer.id, action: 'gdpr_erasure_recorded' } })
  assert.equal((record.metadata as { counts: { orderAttachmentsDeleted: number } }).counts.orderAttachmentsDeleted, 3)
  assert.doesNotMatch(JSON.stringify(record.metadata), /customer po|proof of address/)
})

test('[order attachments] erasing a guest order on its own (order-first) deletes its attachments too, and a failed file removal is reported, not silent', { skip }, async (t) => {
  const { db, routes } = await load()
  const fx = await seedOrders(db)
  t.after(() => fx.cleanup())
  await as(db, 'ADMIN')
  const id = ((await (await routes.handleUpload(upload(PDF('guest'), 'guest.pdf'), { kind: 'sales-orders', orderId: fx.guest.id })).json()) as { id: string }).id
  const { storedName } = await db.orderAttachment.findUniqueOrThrow({ where: { id }, select: { storedName: true } })
  const { eraseOrderPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const result = await eraseOrderPersonalData(fx.guest.id, { trigger: 'ON_REQUEST', userId: null })
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(await db.orderAttachment.count({ where: { id } }), 0)
  assert.ok(!filesOnDisk().includes(storedName))

  // A file that cannot be removed (the path is a non-empty directory here) is named in an ERROR activity row for an operator.
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const stuck = `${randomUUID()}.pdf`
  mkdirSync(path.join(attachmentDir, stuck), { recursive: true })
  writeFileSync(path.join(attachmentDir, stuck, 'blocker'), 'x')
  await db.orderAttachment.create({ data: { salesOrderId: fx.so2.id, storedName: stuck, originalFilename: 'stuck.pdf', mimeType: 'application/pdf', byteSize: 1, sha256: 'y'.repeat(64), uploadedByUserId: 'u' } })
  const second = await eraseOrderPersonalData(fx.so2.id, { trigger: 'ON_REQUEST', userId: null })
  assert.equal(second.success, true, JSON.stringify(second))
  assert.equal(await db.orderAttachment.count({ where: { storedName: stuck } }), 0, 'the row is gone regardless')
  const flagged = await db.activityLog.findMany({ where: { action: 'erasure_attachment_files_not_removed', level: 'ERROR' }, orderBy: { createdAt: 'desc' }, take: 1 })
  assert.equal(flagged.length, 1)
  assert.match(JSON.stringify(flagged[0]!.metadata), new RegExp(stuck.replace('.', '\\.')))
  await db.activityLog.deleteMany({ where: { action: 'erasure_attachment_files_not_removed' } })

  // DURABLE: the failed removal left a queue entry (committed with the row deletion), and a later drain removes the file once it can and clears the entry.
  const { drainOrderAttachmentFileDeletions } = await import('@/lib/domain/order-attachments')
  const queued = await db.orderAttachmentFileDeletion.findUniqueOrThrow({ where: { storedName: stuck } })
  assert.equal(queued.attempts, 1, 'the failed attempt is counted')
  assert.deepEqual((await drainOrderAttachmentFileDeletions()).failed, [stuck], 'still blocked: still owed')
  rmSync(path.join(attachmentDir, stuck), { recursive: true, force: true })
  writeFileSync(path.join(attachmentDir, stuck), 'customer file still on disk')
  const drained = await drainOrderAttachmentFileDeletions()
  assert.deepEqual(drained.failed, [])
  assert.ok(!filesOnDisk().includes(stuck), 'the retry removed the file')
  assert.equal(await db.orderAttachmentFileDeletion.count({ where: { storedName: stuck } }), 0, 'and cleared its entry')
})

test('[order attachments] the deletion obligation commits WITH the row deletion: a crash before any unlink leaves every file queued, and a drain removes them', { skip }, async (t) => {
  const { db, routes } = await load()
  const fx = await seedOrders(db)
  t.after(() => fx.cleanup())
  await as(db, 'ADMIN')
  const id = ((await (await routes.handleUpload(upload(PDF('crash'), 'crash.pdf'), { kind: 'sales-orders', orderId: fx.so1.id })).json()) as { id: string }).id
  const { storedName } = await db.orderAttachment.findUniqueOrThrow({ where: { id }, select: { storedName: true } })
  const { deleteSalesOrderAttachmentsInTx, drainOrderAttachmentFileDeletions } = await import('@/lib/domain/order-attachments')
  // The transaction that deletes the row (the erasure's) commits; the process then dies before any unlink: nothing after the commit runs.
  await db.$transaction(async (tx) => { await deleteSalesOrderAttachmentsInTx(tx, [fx.so1.id]) })
  assert.equal(await db.orderAttachment.count({ where: { id } }), 0)
  assert.ok(filesOnDisk().includes(storedName), 'the customer file is still on disk')
  assert.equal(await db.orderAttachmentFileDeletion.count({ where: { storedName } }), 1, 'and a durable record points at it')
  await drainOrderAttachmentFileDeletions()
  assert.ok(!filesOnDisk().includes(storedName))
  assert.equal(await db.orderAttachmentFileDeletion.count({ where: { storedName } }), 0)

  // A transaction that ROLLS BACK queues nothing and keeps the row (and its file).
  const id2 = ((await (await routes.handleUpload(upload(PDF('kept'), 'kept.pdf'), { kind: 'sales-orders', orderId: fx.so2.id })).json()) as { id: string }).id
  const kept = (await db.orderAttachment.findUniqueOrThrow({ where: { id: id2 }, select: { storedName: true } })).storedName
  await assert.rejects(db.$transaction(async (tx) => { await deleteSalesOrderAttachmentsInTx(tx, [fx.so2.id]); throw new Error('rollback') }), /rollback/)
  assert.equal(await db.orderAttachment.count({ where: { id: id2 } }), 1)
  assert.equal(await db.orderAttachmentFileDeletion.count({ where: { storedName: kept } }), 0)
  assert.ok(filesOnDisk().includes(kept))
})

test('[order attachments] an upload reserves its file durably: success leaves no queue entry, a rejected one is drained, and a crashed one is drained once due', { skip }, async (t) => {
  const { db, routes } = await load()
  const fx = await seedOrders(db)
  t.after(() => fx.cleanup())
  await as(db, 'ADMIN')
  const { drainOrderAttachmentFileDeletions, reserveOrderAttachmentFile } = await import('@/lib/domain/order-attachments')
  const { newOrderAttachmentStoredName, storeOrderAttachmentFile } = await import('@/lib/order-attachment-storage')
  const queueBefore = await db.orderAttachmentFileDeletion.count()

  // Success: the reservation is released by the row insert.
  assert.equal((await routes.handleUpload(upload(PDF('ok'), 'ok.pdf'), { kind: 'purchase-orders', orderId: fx.po1.id })).status, 201)
  assert.equal(await db.orderAttachmentFileDeletion.count(), queueBefore, 'no reservation left after a successful upload')

  // Rejected AFTER the file was written (the order was erased meanwhile): no file, no entry.
  await db.salesOrder.update({ where: { id: fx.guest.id }, data: { erasedAt: new Date() } })
  const filesBefore = filesOnDisk()
  assert.equal((await routes.handleUpload(upload(PDF('late'), 'late.pdf'), { kind: 'sales-orders', orderId: fx.guest.id })).status, 409)
  assert.deepEqual(filesOnDisk(), filesBefore)
  assert.equal(await db.orderAttachmentFileDeletion.count(), queueBefore)

  // Crashed upload: reserved, file written, process dies before the row. The in-flight file is left alone while the reservation is in the future...
  const name = newOrderAttachmentStoredName('pdf')
  await reserveOrderAttachmentFile(name)
  const stored = await storeOrderAttachmentFile(PDF('crash'), 'pdf', { storedName: name })
  assert.equal(stored.ok, true)
  assert.ok(filesOnDisk().includes(name))
  await drainOrderAttachmentFileDeletions()
  assert.ok(filesOnDisk().includes(name), 'not due yet: an in-flight upload is not drained')
  // ...and once due, the untracked file is removed and the entry cleared.
  await db.orderAttachmentFileDeletion.update({ where: { storedName: name }, data: { queuedAt: new Date(Date.now() - 1000) } })
  await drainOrderAttachmentFileDeletions()
  assert.ok(!filesOnDisk().includes(name))
  assert.equal(await db.orderAttachmentFileDeletion.count({ where: { storedName: name } }), 0)
})

test('[order attachments] the reset queues attachment files in the transaction that deletes the rows (sales and purchase), so a crash after commit loses none', { skip }, async (t) => {
  const { db, routes } = await load()
  const fx = await seedOrders(db)
  t.after(() => fx.cleanup())
  await as(db, 'ADMIN')
  const put = async (kind: string, orderId: string, tag: string) => ((await (await routes.handleUpload(upload(PDF(tag), `${tag}.pdf`), { kind, orderId })).json()) as { id: string }).id
  const soId = await put('sales-orders', fx.so1.id, 'reset so')
  const poId = await put('purchase-orders', fx.po1.id, 'reset po')
  const names = (await db.orderAttachment.findMany({ where: { id: { in: [soId, poId] } }, select: { storedName: true } })).map((r) => r.storedName)
  const { queueOrderAttachmentFilesInTx, drainOrderAttachmentFileDeletions } = await import('@/lib/domain/order-attachments')
  // The reset's two transactions, in miniature: queue, then delete the orders (rows cascade). The process then dies before any unlink.
  await db.$transaction(async (tx) => { await queueOrderAttachmentFilesInTx(tx, 'sales'); await tx.salesOrder.deleteMany({ where: { id: fx.so1.id } }) })
  await db.$transaction(async (tx) => { await queueOrderAttachmentFilesInTx(tx, 'purchase'); await tx.purchaseOrder.deleteMany({ where: { id: fx.po1.id } }) })
  assert.equal(await db.orderAttachment.count({ where: { id: { in: [soId, poId] } } }), 0, 'rows cascaded away with their orders')
  for (const n of names) assert.ok(filesOnDisk().includes(n), 'PRECONDITION: the files are still on disk')
  assert.equal(await db.orderAttachmentFileDeletion.count({ where: { storedName: { in: names } } }), 2, 'and both are queued durably')
  await drainOrderAttachmentFileDeletions()
  for (const n of names) assert.ok(!filesOnDisk().includes(n), 'drained')
  assert.equal(await db.orderAttachmentFileDeletion.count({ where: { storedName: { in: names } } }), 0)

  // The reset action itself queues inside both of its transactions and drains afterwards.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('app/actions/reset.ts', 'utf8')
  assert.match(src, /queueOrderAttachmentFilesInTx\(tx, 'sales'\)\n\s*await tx\.salesOrder\.deleteMany/)
  assert.match(src, /queueOrderAttachmentFilesInTx\(tx, 'purchase'\)\n\s*await tx\.purchaseOrder\.deleteMany/)
  assert.match(src, /drainOrderAttachmentFileDeletions\(/)
  assert.doesNotMatch(src, /removeOrderAttachmentFiles/, 'no best-effort unlink outside the queue')
})
