'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Download, Loader2, Paperclip, Trash2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useFormatDateTime } from '@/components/providers/timezone-provider'
import { ORDER_ATTACHMENT_ACCEPT, ORDER_ATTACHMENT_ALLOWED_TEXT, MAX_ORDER_ATTACHMENT_BYTES } from '@/lib/order-attachment-types'
import type { OrderAttachmentView } from '@/lib/domain/order-attachments'

/**
 * Supporting documents of one order (supplier quotes, proformas, packing lists, customer purchase orders, emails). Rendered under the purchase-order
 * and sales-order detail pages. The server decides what may be uploaded, downloaded and deleted; `canEdit` only hides the controls a user would be refused.
 */
export type OrderAttachmentsKind = 'purchase' | 'sales'

const SEGMENT: Record<OrderAttachmentsKind, string> = { purchase: 'purchase-orders', sales: 'sales-orders' }

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function orderAttachmentUrl(kind: OrderAttachmentsKind, orderId: string, id?: string): string {
  const base = `/api/order-attachments/${SEGMENT[kind]}/${encodeURIComponent(orderId)}`
  return id ? `${base}/${encodeURIComponent(id)}` : base
}

async function errorFrom(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown }
    return typeof body.error === 'string' ? body.error : fallback
  } catch {
    return fallback
  }
}

export function OrderAttachmentsCard({
  kind,
  orderId,
  attachments,
  canEdit,
}: {
  kind: OrderAttachmentsKind
  orderId: string
  attachments: OrderAttachmentView[]
  canEdit: boolean
}) {
  const router = useRouter()
  const formatDateTime = useFormatDateTime()
  const fileInput = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<OrderAttachmentView | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  async function upload(file: File) {
    setError(null)
    if (file.size > MAX_ORDER_ATTACHMENT_BYTES) {
      setError(`File too large. Maximum ${Math.round(MAX_ORDER_ATTACHMENT_BYTES / (1024 * 1024))}MB.`)
      return
    }
    setUploading(true)
    try {
      const body = new FormData()
      body.append('file', file)
      const res = await fetch(orderAttachmentUrl(kind, orderId), { method: 'POST', body })
      if (!res.ok) {
        setError(await errorFrom(res, 'Upload failed.'))
        return
      }
      router.refresh()
    } catch {
      setError('Upload failed. Check your connection and try again.')
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  async function confirmDelete() {
    if (!toDelete) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const res = await fetch(orderAttachmentUrl(kind, orderId, toDelete.id), { method: 'DELETE' })
      if (!res.ok) {
        setDeleteError(await errorFrom(res, 'Could not delete the attachment.'))
        return
      }
      setToDelete(null)
      router.refresh()
    } catch {
      setDeleteError('Could not delete the attachment. Check your connection and try again.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="rounded-md border" data-testid="order-attachments-card">
      <div className="flex items-center justify-between px-4 py-2 bg-muted/50 text-sm font-medium">
        <span className="flex items-center gap-2"><Paperclip className="h-4 w-4" aria-hidden="true" />Attachments ({attachments.length})</span>
        {canEdit && (
          <>
            <input
              ref={fileInput}
              type="file"
              accept={ORDER_ATTACHMENT_ACCEPT}
              className="sr-only"
              aria-label="Choose a file to attach"
              disabled={uploading}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void upload(file)
              }}
            />
            <Button size="sm" variant="outline" disabled={uploading} onClick={() => fileInput.current?.click()}>
              {uploading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Upload className="h-4 w-4 mr-1" />}
              {uploading ? 'Uploading…' : 'Upload'}
            </Button>
          </>
        )}
      </div>

      {attachments.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No attachments.{canEdit ? ` Upload a supporting document: ${ORDER_ATTACHMENT_ALLOWED_TEXT}, up to ${Math.round(MAX_ORDER_ATTACHMENT_BYTES / (1024 * 1024))}MB.` : ''}
        </p>
      ) : (
        <div className="divide-y">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="px-4 py-3 text-sm flex items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="font-medium truncate block" title={attachment.originalFilename}>{attachment.originalFilename}</span>
                <span className="text-xs text-muted-foreground">
                  {formatAttachmentSize(attachment.byteSize)} · {formatDateTime(attachment.uploadedAt, { day: 'numeric', month: 'short', year: 'numeric' })}
                  {attachment.uploadedByName ? ` · ${attachment.uploadedByName}` : ''}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <a
                  href={orderAttachmentUrl(kind, orderId, attachment.id)}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  aria-label={`Download ${attachment.originalFilename}`}
                >
                  <Download className="h-4 w-4 mr-1" />Download
                </a>
                {canEdit && (
                  <Button size="sm" variant="outline" aria-label={`Delete ${attachment.originalFilename}`} onClick={() => { setDeleteError(null); setToDelete(attachment) }}>
                    <Trash2 className="h-4 w-4 mr-1" />Delete
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <p role="alert" className="px-4 py-2 text-sm text-destructive">{error}</p>}

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => { if (!open) setToDelete(null) }}
        title="Delete attachment"
        description={<p>Delete <strong>{toDelete?.originalFilename}</strong> from this order? It disappears from the list and can no longer be downloaded.</p>}
        confirmLabel="Delete"
        destructive
        pending={deleting}
        error={deleteError}
        onConfirm={() => { void confirmDelete() }}
      />
    </div>
  )
}
