'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp, Pencil, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { updateAdjustmentMovement, type AdjustmentMovementRow } from '@/app/actions/stock'
import { ProductLink } from '@/components/inventory/product-link'

type Props = {
  initialRows: AdjustmentMovementRow[]
}

type EditState = {
  qty: string
  note: string
  saving: boolean
  error?: string
}

function formatDate(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export function AdjustmentHistory({ initialRows }: Props) {
  const [rows, setRows] = useState(initialRows)
  const [collapsed, setCollapsed] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editState, setEditState] = useState<EditState | null>(null)

  function startEdit(row: AdjustmentMovementRow) {
    setEditingId(row.id)
    setEditState({ qty: String(row.signedQty), note: row.note ?? '', saving: false })
  }

  function cancelEdit() {
    setEditingId(null)
    setEditState(null)
  }

  async function saveEdit(id: string) {
    if (!editState) return
    const qty = Number(editState.qty)
    if (isNaN(qty) || qty === 0) {
      setEditState((s) => s ? { ...s, error: 'Enter a non-zero quantity.' } : s)
      return
    }
    setEditState((s) => s ? { ...s, saving: true, error: undefined } : s)
    const res = await updateAdjustmentMovement(id, qty, editState.note || null)
    if (res.success) {
      setRows((prev) =>
        prev.map((r) =>
          r.id === id
            ? { ...r, signedQty: qty, note: editState.note || null }
            : r
        )
      )
      setEditingId(null)
      setEditState(null)
    } else {
      setEditState((s) => s ? { ...s, saving: false, error: res.message } : s)
    }
  }

  if (rows.length === 0) return null

  const visible = collapsed ? rows.slice(0, 10) : rows

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
        <h2 className="text-sm font-semibold">Adjustment History</h2>
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? (
            <><ChevronDown className="h-3.5 w-3.5" /> Show all {rows.length}</>
          ) : (
            <><ChevronUp className="h-3.5 w-3.5" /> Collapse</>
          )}
        </button>
      </div>

      {/* Header */}
      <div className="grid grid-cols-[1fr_1fr_auto_1fr_auto] gap-3 px-4 py-2 bg-muted/20 text-xs font-medium text-muted-foreground border-b border-border">
        <span>Product</span>
        <span>Warehouse</span>
        <span className="w-24 text-right">Qty</span>
        <span>Reason / Note</span>
        <span className="w-32 text-right">Date</span>
      </div>

      {visible.map((row) => {
        const isEditing = editingId === row.id
        return (
          <div
            key={row.id}
            className="grid grid-cols-[1fr_1fr_auto_1fr_auto] gap-3 px-4 py-2.5 items-center border-b border-border/50 last:border-0 hover:bg-muted/10 group"
          >
            {/* Product */}
            <div className="min-w-0">
              <ProductLink productId={row.productId} sku={row.productSku} name={row.productName} skuClassName="font-mono text-xs font-medium" />
            </div>

            {/* Warehouse */}
            <span className="text-xs text-muted-foreground">
              {row.warehouseCode} — {row.warehouseName}
            </span>

            {/* Qty */}
            {isEditing ? (
              <Input
                type="number"
                step="1"
                value={editState?.qty ?? ''}
                onChange={(e) => setEditState((s) => s ? { ...s, qty: e.target.value } : s)}
                className={`h-7 w-24 text-right text-xs font-mono ${
                  Number(editState?.qty) > 0 ? 'text-green-700 dark:text-green-400' :
                  Number(editState?.qty) < 0 ? 'text-destructive' : ''
                }`}
                autoFocus
              />
            ) : (
              <span className={`text-sm font-mono font-medium text-right w-24 ${
                row.signedQty > 0 ? 'text-green-700 dark:text-green-400' :
                row.signedQty < 0 ? 'text-destructive' : ''
              }`}>
                {row.signedQty > 0 ? `+${row.signedQty}` : row.signedQty}
              </span>
            )}

            {/* Note */}
            {isEditing ? (
              <div className="flex items-center gap-2">
                <Input
                  value={editState?.note ?? ''}
                  onChange={(e) => setEditState((s) => s ? { ...s, note: e.target.value } : s)}
                  placeholder="Reason / note"
                  className="h-7 text-xs"
                />
                {editState?.error && (
                  <span className="text-xs text-destructive whitespace-nowrap">{editState.error}</span>
                )}
              </div>
            ) : (
              <span className="text-xs text-muted-foreground truncate">{row.note ?? '—'}</span>
            )}

            {/* Date + actions */}
            <div className="flex items-center justify-end gap-2 w-32">
              {isEditing ? (
                <>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 text-green-600"
                    onClick={() => saveEdit(row.id)}
                    disabled={editState?.saving}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    onClick={cancelEdit}
                    disabled={editState?.saving}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </>
              ) : (
                <>
                  <span className="text-xs text-muted-foreground">{formatDate(row.createdAt)}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => startEdit(row)}
                    title="Edit"
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                </>
              )}
            </div>
          </div>
        )
      })}

      {collapsed && rows.length > 10 && (
        <div className="px-4 py-2 text-center">
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground underline"
            onClick={() => setCollapsed(false)}
          >
            Show {rows.length - 10} more…
          </button>
        </div>
      )}
    </Card>
  )
}
