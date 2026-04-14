'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp, Pencil, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { MobileRecordCard, MobileRecordField, MobileRecordList, ResponsiveTableLayout } from '@/components/ui/mobile-records'
import { updateAdjustmentMovement, type AdjustmentMovementRow } from '@/app/actions/stock'
import { ProductLink } from '@/components/inventory/product-link'
import { ProductThumb } from '@/components/inventory/product-thumb'

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

      <ResponsiveTableLayout
        mobile={(
          <MobileRecordList className="p-3">
            {visible.map((row) => {
              const isEditing = editingId === row.id
              return (
                <MobileRecordCard key={row.id}>
                  <div className="flex items-start gap-3">
                    <ProductThumb productId={row.productId} imageUrl={row.imageUrl} name={row.productName} />
                    <div className="min-w-0 flex-1">
                      <ProductLink productId={row.productId} sku={row.productSku} name={row.productName} skuClassName="font-mono text-sm font-medium shrink-0" nameClassName="text-xs text-muted-foreground truncate" />
                    </div>
                    {isEditing ? (
                      <div className="flex items-center gap-1">
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-green-600" onClick={() => saveEdit(row.id)} disabled={editState?.saving}>
                          <Check className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={cancelEdit} disabled={editState?.saving}>
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : (
                      <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => startEdit(row)} title="Edit">
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <MobileRecordField
                      label="Warehouse"
                      value={`${row.warehouseCode} — ${row.warehouseName}`}
                    />
                    <MobileRecordField
                      label="Qty"
                      value={isEditing ? (
                        <Input
                          type="number"
                          step="1"
                          value={editState?.qty ?? ''}
                          onChange={(e) => setEditState((s) => s ? { ...s, qty: e.target.value } : s)}
                          className={`h-8 text-right text-sm font-mono ${
                            Number(editState?.qty) > 0 ? 'text-green-700 dark:text-green-400' :
                            Number(editState?.qty) < 0 ? 'text-destructive' : ''
                          }`}
                          autoFocus
                        />
                      ) : (
                        <span className={`font-mono ${
                          row.signedQty > 0 ? 'text-green-700 dark:text-green-400' :
                          row.signedQty < 0 ? 'text-destructive' : ''
                        }`}>
                          {row.signedQty > 0 ? `+${row.signedQty}` : row.signedQty}
                        </span>
                      )}
                    />
                    <MobileRecordField label="Date" value={formatDate(row.createdAt)} className="col-span-2" />
                    <MobileRecordField
                      label="Reason / Note"
                      value={isEditing ? (
                        <Input
                          value={editState?.note ?? ''}
                          onChange={(e) => setEditState((s) => s ? { ...s, note: e.target.value } : s)}
                          placeholder="Reason / note"
                          className="h-8 text-sm"
                        />
                      ) : (
                        row.note ?? '—'
                      )}
                      className="col-span-2"
                    />
                  </div>

                  {isEditing && editState?.error && (
                    <p className="mt-2 text-xs text-destructive">{editState.error}</p>
                  )}
                </MobileRecordCard>
              )
            })}
          </MobileRecordList>
        )}
        desktop={(
          <Table className="min-w-[700px]">
            <TableHeader className="bg-muted/20">
              <TableRow>
                <TableHead className="w-9 text-xs" />
                <TableHead className="text-xs">Product</TableHead>
                <TableHead className="text-xs">Warehouse</TableHead>
                <TableHead className="text-xs text-right w-20">Qty</TableHead>
                <TableHead className="text-xs">Reason / Note</TableHead>
                <TableHead className="text-xs text-right">Date</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => {
                const isEditing = editingId === row.id
                return (
                  <TableRow key={row.id} className="group">
                    <TableCell className="w-9 py-1.5">
                      <ProductThumb productId={row.productId} imageUrl={row.imageUrl} name={row.productName} />
                    </TableCell>
                    <TableCell className="py-1.5">
                      <div className="min-w-0 overflow-hidden">
                        <ProductLink productId={row.productId} sku={row.productSku} name={row.productName} skuClassName="font-mono text-xs font-medium shrink-0" nameClassName="text-xs text-muted-foreground truncate" />
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap py-1.5">
                      {row.warehouseCode} — {row.warehouseName}
                    </TableCell>
                    <TableCell className="text-right w-20 py-1.5">
                      {isEditing ? (
                        <Input
                          type="number"
                          step="1"
                          value={editState?.qty ?? ''}
                          onChange={(e) => setEditState((s) => s ? { ...s, qty: e.target.value } : s)}
                          className={`h-7 text-right text-xs font-mono ${
                            Number(editState?.qty) > 0 ? 'text-green-700 dark:text-green-400' :
                            Number(editState?.qty) < 0 ? 'text-destructive' : ''
                          }`}
                          autoFocus
                        />
                      ) : (
                        <span className={`text-sm font-mono font-medium ${
                          row.signedQty > 0 ? 'text-green-700 dark:text-green-400' :
                          row.signedQty < 0 ? 'text-destructive' : ''
                        }`}>
                          {row.signedQty > 0 ? `+${row.signedQty}` : row.signedQty}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="py-1.5">
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
                        <span className="text-xs text-muted-foreground truncate block max-w-[200px]">{row.note ?? '—'}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap py-1.5">
                      <span className="text-xs text-muted-foreground">{formatDate(row.createdAt)}</span>
                    </TableCell>
                    <TableCell className="w-8 py-1.5">
                      {isEditing ? (
                        <div className="flex items-center gap-1">
                          <Button size="icon" variant="ghost" className="h-6 w-6 text-green-600"
                            onClick={() => saveEdit(row.id)} disabled={editState?.saving}>
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="icon" variant="ghost" className="h-6 w-6"
                            onClick={cancelEdit} disabled={editState?.saving}>
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <Button size="icon" variant="ghost"
                          className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={() => startEdit(row)} title="Edit">
                          <Pencil className="h-3 w-3" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      />

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
