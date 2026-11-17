import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { logActivity } from '@/lib/activity-log'
import { requireApiAuth, type AuthSession } from '@/lib/auth/server'
import {
  canEditOrderAttachments,
  canViewOrderAttachments,
  createOrderAttachment,
  findOrderAttachment,
  softDeleteOrderAttachment,
  type OrderAttachmentKind,
} from '@/lib/domain/order-attachments'
import { removeOrderAttachmentFiles, storeOrderAttachmentFile } from '@/lib/order-attachment-storage'
import { fileScanAuditMetadata } from '@/lib/security/file-scan'
import {
  MAX_ORDER_ATTACHMENT_BYTES,
  attachmentContentDisposition,
  displayNameForAttachment,
  validateOrderAttachment,
} from '@/lib/security/order-attachment-validation'
import { resolveOrderAttachmentFilePath } from '@/lib/upload-storage'
import { uploadFileResponse } from '@/lib/upload-file-response'

/**
 * THE HTTP SURFACE OF ORDER ATTACHMENTS (shared by the route files so the behaviour is testable without Next).
 *
 *   POST   /api/order-attachments/<purchase-orders|sales-orders>/<order id>        multipart `file`
 *   GET    /api/order-attachments/<purchase-orders|sales-orders>/<order id>/<id>   download
 *   DELETE /api/order-attachments/<purchase-orders|sales-orders>/<order id>/<id>   soft delete
 *
 * Authentication first (401), then the permission for that order type (403), then the lookup by (order id, attachment id) (404). A file is
 * never located from a name: the row names it, and the row is found by id within its own order.
 */
const MULTIPART_ENVELOPE_ALLOWANCE = 1024 * 1024

/**
 * Read a request body up to `max` bytes. Returns null (and cancels the stream, so the sender is not read further) the moment the running total passes `max`.
 */
export async function readBodyCapped(req: Request, max: number): Promise<Buffer | null> {
  if (!req.body) return Buffer.alloc(0)
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, total)
}

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const

export function kindFromSegment(segment: string): OrderAttachmentKind | null {
  if (segment === 'purchase-orders') return 'purchase'
  if (segment === 'sales-orders') return 'sales'
  return null
}

function json(body: object, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

const ENTITY: Record<OrderAttachmentKind, { entityType: 'PURCHASE_ORDER' | 'SALES_ORDER'; tag: string }> = {
  purchase: { entityType: 'PURCHASE_ORDER', tag: 'purchase' },
  sales: { entityType: 'SALES_ORDER', tag: 'sales' },
}

type Params = { kind: string; orderId: string; id?: string }

type Gate = { response: NextResponse } | { response?: undefined; kind: OrderAttachmentKind; session: AuthSession }

async function authorise(kindSegment: string, mode: 'view' | 'edit'): Promise<Gate> {
  const kind = kindFromSegment(kindSegment)
  if (!kind) return { response: json({ error: 'Not found' }, 404) }
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return { response: session }
  const allowed = mode === 'view' ? canViewOrderAttachments(session.user.role, kind) : canEditOrderAttachments(session.user.role, kind)
  if (!allowed) return { response: json({ error: 'Forbidden' }, 403) }
  return { kind, session }
}

export async function handleUpload(req: Request, params: Params): Promise<NextResponse> {
  const gate = await authorise(params.kind, 'edit')
  if (gate.response) return gate.response
  const { kind, session } = gate

  // Refuse an oversize body before it is read into memory (the multipart envelope adds a little to the file).
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_ORDER_ATTACHMENT_BYTES + 1024 * 1024) {
    return json({ error: `File too large. Maximum ${Math.round(MAX_ORDER_ATTACHMENT_BYTES / (1024 * 1024))}MB.` }, 413)
  }

  // The body is read through a STREAMING BYTE COUNTER that stops at the cap (plus the multipart envelope), so an oversize upload is refused after at most the cap
  // has been buffered, whatever its Content-Length claimed (or omitted, as a chunked body does), and never parsed as a whole.
  const body = await readBodyCapped(req, MAX_ORDER_ATTACHMENT_BYTES + MULTIPART_ENVELOPE_ALLOWANCE)
  if (body === null) return json({ error: `File too large. Maximum ${Math.round(MAX_ORDER_ATTACHMENT_BYTES / (1024 * 1024))}MB.` }, 413)
  let file: File | null = null
  try {
    const form = await new Request(req.url, { method: 'POST', headers: { 'content-type': req.headers.get('content-type') ?? '' }, body: new Uint8Array(body) }).formData()
    const entry = form.get('file')
    if (entry instanceof File) file = entry
  } catch {
    return json({ error: 'Invalid upload' }, 400)
  }
  if (!file) return json({ error: 'No file' }, 400)

  const buffer = Buffer.from(await file.arrayBuffer())
  const verdict = validateOrderAttachment(file.name, buffer)
  if (!verdict.ok) return json({ error: verdict.error }, verdict.status)

  const stored = await storeOrderAttachmentFile(buffer, verdict.extension)
  if (!stored.ok) {
    await logActivity({
      entityType: ENTITY[kind].entityType,
      entityId: params.orderId,
      tag: ENTITY[kind].tag,
      action: 'attachment_rejected',
      level: 'WARNING',
      description: 'Rejected an order attachment upload',
      userId: session.user.id,
      metadata: { sizeBytes: buffer.length, ...fileScanAuditMetadata(stored.scan) },
    })
    return json({ error: stored.error }, stored.status)
  }

  const created = await createOrderAttachment({
    kind,
    orderId: params.orderId,
    storedName: stored.storedName,
    originalFilename: displayNameForAttachment(file.name, verdict.extension),
    mimeType: verdict.mimeType,
    byteSize: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    uploadedByUserId: session.user.id,
  }).catch(async (error) => {
    await removeOrderAttachmentFiles([stored.storedName])
    throw error
  })
  if (!created.ok) {
    // The row was not written, so the file is an orphan: remove it.
    await removeOrderAttachmentFiles([stored.storedName])
    if (created.reason === 'ORDER_ERASED') return json({ error: 'This order has been anonymised and cannot take attachments' }, 409)
    return json({ error: 'Not found' }, 404)
  }

  // The file name is NOT logged: a sales-order attachment name can carry a customer's name.
  await logActivity({
    entityType: ENTITY[kind].entityType,
    entityId: params.orderId,
    tag: ENTITY[kind].tag,
    action: 'attachment_uploaded',
    description: 'Attached a document to the order',
    userId: session.user.id,
    metadata: { attachmentId: created.id, mimeType: verdict.mimeType, sizeBytes: buffer.length, ...fileScanAuditMetadata(stored.scan) },
  })
  return json({ id: created.id }, 201)
}

export async function handleDownload(_req: Request, params: Params): Promise<NextResponse> {
  const gate = await authorise(params.kind, 'view')
  if (gate.response) return gate.response
  const row = params.id ? await findOrderAttachment(gate.kind, params.orderId, params.id) : null
  if (!row) return json({ error: 'Not found' }, 404)
  const filepath = resolveOrderAttachmentFilePath(row.storedName)
  if (!filepath) return json({ error: 'Not found' }, 404)
  try {
    return await uploadFileResponse(filepath, {
      'Content-Type': row.mimeType,
      'Content-Disposition': attachmentContentDisposition(row.originalFilename),
      'Content-Length': String(row.byteSize),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    })
  } catch {
    return json({ error: 'Not found' }, 404)
  }
}

export async function handleDelete(_req: Request, params: Params): Promise<NextResponse> {
  const gate = await authorise(params.kind, 'edit')
  if (gate.response) return gate.response
  const { kind, session } = gate
  const removed = params.id ? await softDeleteOrderAttachment(kind, params.orderId, params.id) : null
  if (!removed) return json({ error: 'Not found' }, 404)
  await logActivity({
    entityType: ENTITY[kind].entityType,
    entityId: params.orderId,
    tag: ENTITY[kind].tag,
    action: 'attachment_deleted',
    description: 'Removed a document from the order',
    userId: session.user.id,
    metadata: { attachmentId: params.id, mimeType: removed.mimeType, sizeBytes: removed.byteSize },
  })
  return json({ ok: true }, 200)
}
