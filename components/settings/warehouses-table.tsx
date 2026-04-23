'use client'

import { useEffect, useState } from 'react'
import { Pencil, Trash2, Plus, Loader2, Warehouse } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CountrySelect } from '@/components/ui/country-select'
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
import {
  createWarehouse,
  updateWarehouse,
  deleteWarehouse,
  type WarehouseRow,
  type WarehouseInput,
} from '@/app/actions/settings'

type Props = { warehouses: WarehouseRow[]; showStoreSync?: boolean; onChanged?: () => void }

type WarehouseFormFields = Omit<WarehouseInput, 'syncToStore'> & {
  syncToStore: boolean
}

function toWarehouseInput(fields: WarehouseFormFields): WarehouseInput {
  return {
    ...fields,
    syncToStore: fields.syncToStore,
  }
}

const EMPTY: WarehouseFormFields = {
  code: '',
  name: '',
  type: 'STANDARD',
  contactName: '',
  email: '',
  phone: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  postcode: '',
  country: 'GB',
  availableForSale: true,
  syncToStore: false,
  isDefault: false,
  defaultReturnWarehouse: false,
  active: true,
}

function toInput(w: WarehouseRow): WarehouseFormFields {
  return {
    code: w.code,
    name: w.name,
    type: w.type as WarehouseInput['type'],
    contactName: w.contactName ?? '',
    email: w.email ?? '',
    phone: w.phone ?? '',
    addressLine1: w.addressLine1 ?? '',
    addressLine2: w.addressLine2 ?? '',
    city: w.city ?? '',
    postcode: w.postcode ?? '',
    country: w.country,
    availableForSale: w.availableForSale,
    syncToStore: w.syncToStore,
    isDefault: w.isDefault,
    defaultReturnWarehouse: w.defaultReturnWarehouse,
    active: w.active,
  }
}

// ---------------------------------------------------------------------------
// Dialog form
// ---------------------------------------------------------------------------

function WarehouseDialog({
  open,
  onOpenChange,
  editingId,
  initial,
  onSaved,
  showStoreSync,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingId: string | null
  initial: WarehouseFormFields
  onSaved: (item: WarehouseRow, isNew: boolean) => void
  showStoreSync: boolean
}) {
  const [fields, setFields] = useState<WarehouseFormFields>(initial)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setFields(initial)
    setError('')
  }, [initial, open])

  function set<K extends keyof WarehouseFormFields>(k: K, v: WarehouseFormFields[K]) {
    setFields((f) => ({ ...f, [k]: v }))
  }

  async function handleSave() {
    if (!fields.code.trim()) { setError('Code is required'); return }
    if (!fields.name.trim()) { setError('Name is required'); return }
    setPending(true)
    setError('')
    try {
      const result = editingId
        ? await updateWarehouse(editingId, toWarehouseInput(fields))
        : await createWarehouse(toWarehouseInput(fields))
      if (result.success && result.item) {
        onSaved(result.item, !editingId)
        onOpenChange(false)
      } else {
        setError(result.error ?? 'Failed to save.')
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editingId ? 'Edit Warehouse' : 'Add Warehouse'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Identity */}
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Identity</legend>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Code *</Label>
                <Input value={fields.code} onChange={(e) => set('code', e.target.value.toUpperCase())} placeholder="e.g. WH1" className="h-8 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Name *</Label>
                <Input value={fields.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Main Warehouse" className="h-8 text-sm" />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Type</Label>
              <select
                value={fields.type}
                onChange={(e) => set('type', e.target.value as WarehouseInput['type'])}
                className="w-full h-8 text-sm border border-input rounded-md px-2 bg-background"
              >
                <option value="STANDARD">Standard</option>
                <option value="QUARANTINE">Quarantine</option>
                <option value="RESTOCK">Restock</option>
              </select>
            </div>
          </fieldset>

          {/* Contact */}
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Contact</legend>
            <div className="space-y-1">
              <Label className="text-xs">Contact Name</Label>
              <Input value={fields.contactName ?? ''} onChange={(e) => set('contactName', e.target.value)} placeholder="e.g. John Smith" className="h-8 text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Email</Label>
                <Input value={fields.email ?? ''} onChange={(e) => set('email', e.target.value)} placeholder="warehouse@example.com" className="h-8 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Phone</Label>
                <Input value={fields.phone ?? ''} onChange={(e) => set('phone', e.target.value)} placeholder="+44 1234 567890" className="h-8 text-sm" />
              </div>
            </div>
          </fieldset>

          {/* Address */}
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Address</legend>
            <div className="space-y-1">
              <Label className="text-xs">Address Line 1</Label>
              <Input value={fields.addressLine1 ?? ''} onChange={(e) => set('addressLine1', e.target.value)} className="h-8 text-sm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Address Line 2</Label>
              <Input value={fields.addressLine2 ?? ''} onChange={(e) => set('addressLine2', e.target.value)} className="h-8 text-sm" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">City</Label>
                <Input value={fields.city ?? ''} onChange={(e) => set('city', e.target.value)} className="h-8 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Postcode</Label>
                <Input value={fields.postcode ?? ''} onChange={(e) => set('postcode', e.target.value)} className="h-8 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Country</Label>
                <CountrySelect value={fields.country} onChange={(value) => set('country', value)} allowBlank={false} className="h-8 text-sm" />
              </div>
            </div>
          </fieldset>

          {/* Flags */}
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Flags</legend>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={fields.availableForSale} onChange={(e) => set('availableForSale', e.target.checked)} className="rounded" />
                Available for Sale
              </label>
              {showStoreSync && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={fields.syncToStore} onChange={(e) => set('syncToStore', e.target.checked)} className="rounded" />
                  Sync to Store
                </label>
              )}
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={fields.isDefault} onChange={(e) => set('isDefault', e.target.checked)} className="rounded" />
                Default Warehouse
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={fields.defaultReturnWarehouse} onChange={(e) => set('defaultReturnWarehouse', e.target.checked)} className="rounded" />
                Default Returns
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={fields.active} onChange={(e) => set('active', e.target.checked)} className="rounded" />
                Active
              </label>
            </div>
          </fieldset>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button onClick={handleSave} disabled={pending}>
            {pending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            {editingId ? 'Save Changes' : 'Create Warehouse'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export function WarehousesTable({ warehouses: initial, showStoreSync = true, onChanged }: Props) {
  const [warehouses, setWarehouses] = useState(initial)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [dialogInit, setDialogInit] = useState<WarehouseFormFields>(EMPTY)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  function openAdd() {
    setEditingId(null)
    setDialogInit(EMPTY)
    setDialogOpen(true)
  }

  function openEdit(w: WarehouseRow) {
    setEditingId(w.id)
    setDialogInit(toInput(w))
    setDialogOpen(true)
  }

  function handleSaved(item: WarehouseRow, isNew: boolean) {
    onChanged?.()
    if (isNew) {
      setWarehouses((prev) => [...prev, item])
    } else {
      setWarehouses((prev) => prev.map((w) => (w.id === item.id ? item : w)))
    }
    // If isDefault or defaultReturnWarehouse was set, clear from others in local state
    if (item.isDefault) {
      setWarehouses((prev) => prev.map((w) => w.id === item.id ? w : { ...w, isDefault: false }))
    }
    if (item.defaultReturnWarehouse) {
      setWarehouses((prev) => prev.map((w) => w.id === item.id ? w : { ...w, defaultReturnWarehouse: false }))
    }
  }

  async function handleDelete(w: WarehouseRow) {
    const msg = `Delete warehouse "${w.code} — ${w.name}"?\n\nIf this warehouse has associated stock or orders, it will be deactivated instead.`
    if (!confirm(msg)) return
    setDeletingId(w.id)
    try {
      const result = await deleteWarehouse(w.id)
      if (!result.success) {
        alert(result.error ?? 'Failed to delete.')
        return
      }
      if (result.deactivated) {
        // Update local state to show deactivated
        setWarehouses((prev) => prev.map((x) => x.id === w.id ? { ...x, active: false } : x))
        onChanged?.()
        alert('Warehouse has associated data and was deactivated instead of deleted.')
      } else {
        setWarehouses((prev) => prev.filter((x) => x.id !== w.id))
        onChanged?.()
      }
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Warehouse className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Warehouses</h2>
        </div>
        <Button variant="outline" size="sm" onClick={openAdd}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add Warehouse
        </Button>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Manage your warehouse locations. Warehouse addresses are used as delivery addresses on purchase orders.
      </p>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs">Code</TableHead>
            <TableHead className="text-xs">Name</TableHead>
            <TableHead className="text-xs">Type</TableHead>
            <TableHead className="text-xs">Contact</TableHead>
            <TableHead className="text-xs">City</TableHead>
            <TableHead className="text-xs text-center">Default</TableHead>
            {showStoreSync && <TableHead className="text-xs text-center">Store Sync</TableHead>}
            <TableHead className="text-xs text-center">Active</TableHead>
            <TableHead className="w-20" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {warehouses.length === 0 && (
            <TableRow>
              <TableCell colSpan={showStoreSync ? 9 : 8} className="py-4 text-sm text-muted-foreground text-center">
                No warehouses configured.
              </TableCell>
            </TableRow>
          )}
          {warehouses.map((w) => (
            <TableRow key={w.id} className={!w.active ? 'opacity-50' : undefined}>
              <TableCell className="text-sm font-mono">{w.code}</TableCell>
              <TableCell className="text-sm">{w.name}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{w.type}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{w.contactName || '—'}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{w.city || '—'}</TableCell>
              <TableCell className="text-sm text-center">
                {w.isDefault && <span className="text-green-600">Yes</span>}
                {w.defaultReturnWarehouse && <span className="text-blue-600 ml-1" title="Default return warehouse">R</span>}
              </TableCell>
              {showStoreSync && (
                <TableCell className="text-sm text-center">
                  <span className={w.syncToStore ? 'text-green-600' : 'text-muted-foreground/50'}>
                    {w.syncToStore ? 'Yes' : '—'}
                  </span>
                </TableCell>
              )}
              <TableCell className="text-sm text-center">
                <span className={w.active ? 'text-green-600' : 'text-muted-foreground'}>
                  {w.active ? 'Yes' : 'No'}
                </span>
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1">
                  <Button variant="ghost" size="icon" onClick={() => openEdit(w)} title="Edit">
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(w)} disabled={deletingId === w.id}
                    title="Delete" className="text-destructive hover:text-destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <WarehouseDialog
        key={editingId ?? 'new'}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editingId={editingId}
        initial={dialogInit}
        onSaved={handleSaved}
        showStoreSync={showStoreSync}
      />
    </>
  )
}
