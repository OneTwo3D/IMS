import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { hasPermission, type Permission } from '@/lib/permissions'
import { removeOrderAttachmentFiles } from '@/lib/order-attachment-storage'

/**
 * ORDER ATTACHMENTS: the rows. The bytes are in lib/order-attachment-storage.ts; the HTTP surface is app/api/order-attachments/.
 *
 * Every read and write goes through a (kind, orderId, attachment id) triple, so an attachment id that belongs to another order is simply
 * not found. Nothing here takes a file name from a caller.
 */
export type OrderAttachmentKind = 'purchase' | 'sales'

export const ORDER_ATTACHMENT_PERMISSIONS: Readonly<Record<OrderAttachmentKind, { view: Permission; edit: readonly Permission[] }>> = {
  // View is the module's own key. Edit is the key that creates and edits that order type, plus the key the warehouse holds for receiving (purchase)
  // or processing (sales), because packing lists and delivery notes are the warehouse's documents.
  purchase: { view: 'purchasing', edit: ['purchasing.create', 'purchasing.receive'] },
  sales: { view: 'sales', edit: ['sales.create', 'sales.process'] },
}

export function canViewOrderAttachments(role: string, kind: OrderAttachmentKind): boolean {
  return hasPermission(role, ORDER_ATTACHMENT_PERMISSIONS[kind].view)
}

export function canEditOrderAttachments(role: string, kind: OrderAttachmentKind): boolean {
  return canViewOrderAttachments(role, kind) && ORDER_ATTACHMENT_PERMISSIONS[kind].edit.some((permission) => hasPermission(role, permission))
}

export type OrderAttachmentView = {
  id: string
  originalFilename: string
  mimeType: string
  byteSize: number
  uploadedAt: string
  uploadedByName: string | null
}

function parentWhere(kind: OrderAttachmentKind, orderId: string): Prisma.OrderAttachmentWhereInput {
  return kind === 'purchase' ? { purchaseOrderId: orderId } : { salesOrderId: orderId }
}

/** Live (not deleted) attachments of one order, newest first. */
export async function listOrderAttachments(kind: OrderAttachmentKind, orderId: string): Promise<OrderAttachmentView[]> {
  const rows = await db.orderAttachment.findMany({
    where: { ...parentWhere(kind, orderId), deletedAt: null },
    orderBy: [{ uploadedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, originalFilename: true, mimeType: true, byteSize: true, uploadedAt: true, uploadedByUserId: true },
  })
  const userIds = [...new Set(rows.map((r) => r.uploadedByUserId))]
  const users = userIds.length > 0 ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : []
  const names = new Map(users.map((u) => [u.id, u.name]))
  return rows.map((r) => ({
    id: r.id,
    originalFilename: r.originalFilename,
    mimeType: r.mimeType,
    byteSize: r.byteSize,
    uploadedAt: r.uploadedAt.toISOString(),
    uploadedByName: names.get(r.uploadedByUserId) ?? null,
  }))
}

export type CreateOrderAttachmentInput = {
  kind: OrderAttachmentKind
  orderId: string
  storedName: string
  originalFilename: string
  mimeType: string
  byteSize: number
  sha256: string
  uploadedByUserId: string
}

export type CreateOrderAttachmentResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'ORDER_NOT_FOUND' | 'ORDER_ERASED' }

/**
 * Insert the row UNDER A SHARED LOCK ON THE ORDER ROW. A personal-data erasure locks the order FOR UPDATE and sets erasedAt, then deletes its
 * attachments; taking FOR SHARE here makes an upload either wholly before the erasure (and is then deleted by it) or wholly after it (and is
 * then refused), never interleaved, so an erased order cannot acquire a new file.
 */
export async function createOrderAttachment(input: CreateOrderAttachmentInput): Promise<CreateOrderAttachmentResult> {
  return db.$transaction(async (tx): Promise<CreateOrderAttachmentResult> => {
    if (input.kind === 'sales') {
      const locked = await tx.$queryRaw<Array<{ erasedAt: Date | null }>>`SELECT "erasedAt" FROM "sales_orders" WHERE id = ${input.orderId} FOR SHARE`
      if (locked.length === 0) return { ok: false, reason: 'ORDER_NOT_FOUND' }
      if (locked[0]!.erasedAt) return { ok: false, reason: 'ORDER_ERASED' }
    } else {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "purchase_orders" WHERE id = ${input.orderId} FOR SHARE`
      if (locked.length === 0) return { ok: false, reason: 'ORDER_NOT_FOUND' }
    }
    const row = await tx.orderAttachment.create({
      data: {
        ...(input.kind === 'purchase' ? { purchaseOrderId: input.orderId } : { salesOrderId: input.orderId }),
        storedName: input.storedName,
        originalFilename: input.originalFilename,
        mimeType: input.mimeType,
        byteSize: input.byteSize,
        sha256: input.sha256,
        uploadedByUserId: input.uploadedByUserId,
      },
      select: { id: true },
    })
    return { ok: true, id: row.id }
  })
}

export type OrderAttachmentFile = { id: string; storedName: string; originalFilename: string; mimeType: string; byteSize: number }

/** One live attachment of THIS order, or null (another order's id, a deleted row and an unknown id are all the same answer). */
export async function findOrderAttachment(kind: OrderAttachmentKind, orderId: string, id: string): Promise<OrderAttachmentFile | null> {
  return db.orderAttachment.findFirst({
    where: { id, ...parentWhere(kind, orderId), deletedAt: null },
    select: { id: true, storedName: true, originalFilename: true, mimeType: true, byteSize: true },
  })
}

/**
 * Soft-delete one live attachment of this order. Conditional on deletedAt IS NULL, so two deletes cannot both claim it. Returns the stored name
 * so the caller can remove the file, or null when there was nothing to delete.
 */
export async function softDeleteOrderAttachment(kind: OrderAttachmentKind, orderId: string, id: string, now: Date = new Date()): Promise<{ storedName: string; mimeType: string; byteSize: number } | null> {
  return db.$transaction(async (tx) => {
    const row = await tx.orderAttachment.findFirst({
      where: { id, ...parentWhere(kind, orderId), deletedAt: null },
      select: { storedName: true, mimeType: true, byteSize: true },
    })
    if (!row) return null
    const claimed = await tx.orderAttachment.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: now } })
    return claimed.count === 1 ? row : null
  })
}

/**
 * Rows of sales orders in a transaction that is already erasing them: deleted outright (live and soft-deleted alike), and THE FILES OWED A DELETION ARE RECORDED IN
 * THE SAME TRANSACTION (order_attachment_file_deletions). A file cannot be rolled back, so it is removed after the commit by drainOrderAttachmentFileDeletions; because
 * the obligation commits with the row deletion, a crash or a failed unlink leaves a queue entry that a later drain retries, never a customer file nobody points at.
 * Returns the stored names.
 */
export async function deleteSalesOrderAttachmentsInTx(tx: Prisma.TransactionClient, orderIds: string[]): Promise<string[]> {
  const rows = await tx.orderAttachment.findMany({ where: { salesOrderId: { in: orderIds } }, select: { id: true, storedName: true } })
  if (rows.length === 0) return []
  await tx.orderAttachment.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } })
  await tx.orderAttachmentFileDeletion.createMany({ data: rows.map((r) => ({ storedName: r.storedName })), skipDuplicates: true })
  return rows.map((r) => r.storedName)
}

/**
 * Remove the files in the deletion queue, oldest first, and clear each entry only after its file is gone (already gone counts). A file that cannot be removed keeps
 * its entry (attempts raised) for the next drain. Safe to run concurrently (unlink and the entry delete are both idempotent). Returns what it removed and the names still owed.
 */
export async function drainOrderAttachmentFileDeletions(limit = 500): Promise<{ removed: number; failed: string[] }> {
  const queued = await db.orderAttachmentFileDeletion.findMany({ orderBy: { queuedAt: 'asc' }, take: limit, select: { storedName: true } })
  if (queued.length === 0) return { removed: 0, failed: [] }
  const names = queued.map((q) => q.storedName)
  const result = await removeOrderAttachmentFiles(names)
  const failed = new Set(result.failed)
  const done = names.filter((n) => !failed.has(n))
  if (done.length > 0) await db.orderAttachmentFileDeletion.deleteMany({ where: { storedName: { in: done } } })
  if (failed.size > 0) await db.orderAttachmentFileDeletion.updateMany({ where: { storedName: { in: [...failed] } }, data: { attempts: { increment: 1 } } })
  return { removed: result.removed, failed: [...failed] }
}
