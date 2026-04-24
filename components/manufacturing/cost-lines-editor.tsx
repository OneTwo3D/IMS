'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2, Loader2, AlertTriangle, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import {
  updateManufacturingCostLines,
  type ManufacturingCostLineRow,
} from '@/app/actions/manufacturing'

type DraftLine = {
  description: string
  amountForeign: string
  accountCode: string
}

function toDraft(rows: ManufacturingCostLineRow[]): DraftLine[] {
  return rows.map((r) => ({
    description: r.description,
    amountForeign: r.amountForeign.toString(),
    accountCode: r.accountCode ?? '',
  }))
}

export function ManufacturingCostLinesEditor({
  productionOrderId,
  reference,
  currency,
  fxRateToBase,
  initialLines,
  isCompleted,
  canEdit,
}: {
  productionOrderId: string
  reference: string
  currency: string
  fxRateToBase: number
  initialLines: ManufacturingCostLineRow[]
  isCompleted: boolean
  canEdit: boolean
}) {
  const router = useRouter()
  const [draft, setDraft] = useState<DraftLine[]>(toDraft(initialLines))
  const [originalSnapshot, setOriginalSnapshot] = useState<DraftLine[]>(toDraft(initialLines))
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const totalForeign = draft.reduce((s, l) => {
    const n = Number.parseFloat(l.amountForeign)
    return s + (Number.isFinite(n) ? n : 0)
  }, 0)
  const totalBase = totalForeign * fxRateToBase

  const isDirty = JSON.stringify(draft) !== JSON.stringify(originalSnapshot)

  function addRow() {
    setDraft([...draft, { description: '', amountForeign: '', accountCode: '' }])
    setSaved(false)
  }

  function updateRow(idx: number, patch: Partial<DraftLine>) {
    setDraft(draft.map((l, i) => (i === idx ? { ...l, ...patch } : l)))
    setSaved(false)
  }

  function removeRow(idx: number) {
    setDraft(draft.filter((_, i) => i !== idx))
    setSaved(false)
  }

  function handleSave() {
    setError(null)
    setSaved(false)
    const cleaned = draft
      .filter((l) => l.description.trim().length > 0)
      .map((l) => ({
        description: l.description.trim(),
        amountForeign: Number.parseFloat(l.amountForeign) || 0,
        accountCode: l.accountCode.trim() || null,
      }))
    startTransition(async () => {
      const res = await updateManufacturingCostLines(productionOrderId, cleaned)
      if (res.success) {
        setOriginalSnapshot(JSON.parse(JSON.stringify(draft)))
        setSaved(true)
        router.refresh()
      } else {
        setError(res.error ?? 'Failed to save manufacturing cost lines.')
      }
    })
  }

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-medium">Manufacturing costs</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Per-run overhead (labour, machine time, utilities, etc.). Spread across produced qty into the output cost layer.
            {isCompleted && ' Editing after completion will recalculate the cost layer and post a reclass journal for any consumed units.'}
          </p>
        </div>
        {canEdit && (
          <Button variant="outline" size="sm" onClick={addRow} disabled={isPending}>
            <Plus className="h-4 w-4 mr-1" />Add line
          </Button>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive mb-3">
          <AlertTriangle className="h-4 w-4" />{error}
        </div>
      )}

      {draft.length === 0 ? (
        <p className="text-sm text-muted-foreground italic py-4 text-center">
          No manufacturing cost lines on {reference}.
          {canEdit && ' Click "Add line" to capture labour, machine time, or other overhead.'}
        </p>
      ) : (
        <Table className="rounded-md border min-w-[600px]">
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>#</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount ({currency})</TableHead>
              <TableHead>Account override</TableHead>
              {canEdit && <TableHead className="w-12"></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {draft.map((row, i) => (
              <TableRow key={i}>
                <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                <TableCell>
                  {canEdit ? (
                    <Input
                      value={row.description}
                      onChange={(e) => updateRow(i, { description: e.target.value })}
                      placeholder="e.g. Labour, Machine time"
                      disabled={isPending}
                    />
                  ) : (
                    <span>{row.description}</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {canEdit ? (
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={row.amountForeign}
                      onChange={(e) => updateRow(i, { amountForeign: e.target.value })}
                      placeholder="0.00"
                      className="text-right"
                      disabled={isPending}
                    />
                  ) : (
                    <span className="font-mono">{Number.parseFloat(row.amountForeign).toFixed(2)}</span>
                  )}
                </TableCell>
                <TableCell>
                  {canEdit ? (
                    <Input
                      value={row.accountCode}
                      onChange={(e) => updateRow(i, { accountCode: e.target.value })}
                      placeholder="(default overhead account)"
                      disabled={isPending}
                    />
                  ) : (
                    <span className="font-mono text-xs">{row.accountCode || '—'}</span>
                  )}
                </TableCell>
                {canEdit && (
                  <TableCell>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeRow(i)} disabled={isPending}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
            <TableRow className="bg-muted/30 font-medium">
              <TableCell colSpan={2} className="text-right">Total</TableCell>
              <TableCell className="text-right font-mono">
                {totalForeign.toFixed(2)} {currency}
                {currency !== 'GBP' && (
                  <span className="text-muted-foreground text-xs ml-2">≈ {totalBase.toFixed(2)} GBP</span>
                )}
              </TableCell>
              <TableCell colSpan={canEdit ? 2 : 1}></TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}

      {canEdit && (
        <div className="flex items-center justify-end gap-2 mt-3">
          {saved && !isDirty && (
            <span className="text-xs text-green-600 dark:text-green-400">Saved.</span>
          )}
          <Button onClick={handleSave} disabled={isPending || !isDirty} size="sm">
            {isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
            Save manufacturing costs
          </Button>
        </div>
      )}
    </Card>
  )
}
