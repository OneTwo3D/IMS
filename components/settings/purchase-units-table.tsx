'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Pencil, X, Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { createPurchaseUnit, updatePurchaseUnit, type PurchaseUnitRow } from '@/app/actions/settings'

type Props = { units: PurchaseUnitRow[] }

function PurchaseUnitFormDialog({
  unit,
  onClose,
}: {
  unit: PurchaseUnitRow | null
  onClose: () => void
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [name, setName] = useState(unit?.name ?? '')
  const [abbreviation, setAbbreviation] = useState(unit?.abbreviation ?? '')
  const [factor, setFactor] = useState(unit ? unit.conversionFactor.toString() : '')
  const [stockUnitName, setStockUnitName] = useState(unit?.stockUnitName ?? 'pcs')
  const [error, setError] = useState('')

  function handleSave() {
    setError('')
    if (!name.trim()) { setError('Name is required'); return }
    if (!abbreviation.trim()) { setError('Abbreviation is required'); return }
    const f = parseFloat(factor)
    if (isNaN(f) || f <= 0) { setError('Conversion factor must be greater than 0'); return }

    startTransition(async () => {
      const result = unit
        ? await updatePurchaseUnit(unit.id, { name, abbreviation, conversionFactor: f, stockUnitName })
        : await createPurchaseUnit({ name, abbreviation, conversionFactor: f, stockUnitName })
      if (result.success) {
        router.refresh()
        onClose()
      } else {
        setError(result.error ?? 'Save failed')
      }
    })
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="max-w-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{unit ? 'Edit Purchase Unit' : 'New Purchase Unit'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="space-y-1.5">
            <Label>Name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Box of 100, Roll (1km), Pallet of 48" className="h-9" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Abbreviation *</Label>
              <Input value={abbreviation} onChange={(e) => setAbbreviation(e.target.value)} placeholder="e.g. box, roll, plt" className="h-9 font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label>Conversion factor *</Label>
              <Input
                type="number" min="0.0001" step="any"
                value={factor}
                onChange={(e) => setFactor(e.target.value)}
                placeholder="e.g. 1000"
                className="h-9 font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Stock unit name *</Label>
              <Input value={stockUnitName} onChange={(e) => setStockUnitName(e.target.value)} placeholder="e.g. m, pcs, sheets" className="h-9 font-mono" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Example: 1 roll = 1000 m — abbreviation: &quot;roll&quot;, conversion factor: 1000, stock unit: &quot;m&quot;
          </p>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {unit ? 'Save Changes' : 'Create Unit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function PurchaseUnitsTable({ units }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [editing, setEditing] = useState<PurchaseUnitRow | null | undefined>(undefined)

  function handleToggle(u: PurchaseUnitRow) {
    startTransition(async () => {
      await updatePurchaseUnit(u.id, { active: !u.active })
      router.refresh()
    })
  }

  const active = units.filter((u) => u.active)
  const inactive = units.filter((u) => !u.active)

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setEditing(null)}>
          <Plus className="h-3 w-3 mr-1" />Add Unit
        </Button>
      </div>

      {units.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">No purchase units defined yet.</p>
      ) : (
        <Table className="rounded-md border">
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="text-xs">Name</TableHead>
              <TableHead className="text-xs">Abbr.</TableHead>
              <TableHead className="text-xs text-right">Conversion Factor</TableHead>
              <TableHead className="text-xs">Example</TableHead>
              <TableHead className="text-xs">Status</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...active, ...inactive].map((u) => (
              <TableRow key={u.id} className={!u.active ? 'opacity-50' : ''}>
                <TableCell className="font-medium">{u.name}</TableCell>
                <TableCell className="font-mono text-xs">{u.abbreviation}</TableCell>
                <TableCell className="text-right font-mono text-xs">{u.conversionFactor}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  1 {u.abbreviation} = {u.conversionFactor} {u.stockUnitName}
                </TableCell>
                <TableCell>
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${
                    u.active
                      ? 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200'
                      : 'bg-muted text-muted-foreground border-border'
                  }`}>
                    {u.active ? 'Active' : 'Inactive'}
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1 justify-end">
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setEditing(u)}>
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => handleToggle(u)} disabled={isPending}>
                      {u.active ? <X className="h-3 w-3 text-muted-foreground" /> : <Check className="h-3 w-3 text-muted-foreground" />}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {editing !== undefined && (
        <PurchaseUnitFormDialog unit={editing} onClose={() => setEditing(undefined)} />
      )}
    </div>
  )
}
