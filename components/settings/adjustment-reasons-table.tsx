'use client'

import { useState } from 'react'
import { Pencil, Trash2, Plus, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  createAdjustmentReason,
  updateAdjustmentReason,
  deleteAdjustmentReason,
  type AdjustmentReason,
} from '@/app/actions/settings'

type Props = { reasons: AdjustmentReason[] }

// ---------------------------------------------------------------------------
// Shared reason form fields (controlled)
// ---------------------------------------------------------------------------

type FieldState = { name: string; xeroAccountCode: string; sortOrder: number; active: boolean }

function ReasonFields({
  fields,
  onChange,
  error,
}: {
  fields: FieldState
  onChange: (f: FieldState) => void
  error?: string
}) {
  function set<K extends keyof FieldState>(k: K, v: FieldState[K]) {
    onChange({ ...fields, [k]: v })
  }
  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-end flex-1">
      <div className="space-y-1 min-w-0">
        <Label className="text-xs">Name *</Label>
        <Input
          value={fields.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="e.g. Cycle count correction"
          className="h-7 text-xs"
          required
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
      <div className="space-y-1 w-36">
        <Label className="text-xs">Xero Account Code</Label>
        <Input
          value={fields.xeroAccountCode}
          onChange={(e) => set('xeroAccountCode', e.target.value)}
          placeholder="e.g. 310"
          className="h-7 text-xs"
        />
      </div>
      <div className="space-y-1 w-20">
        <Label className="text-xs">Sort Order</Label>
        <Input
          type="number"
          value={fields.sortOrder}
          onChange={(e) => set('sortOrder', Number(e.target.value))}
          className="h-7 text-xs"
        />
      </div>
      <div className="space-y-1 w-20">
        <Label className="text-xs">Active</Label>
        <select
          value={fields.active ? 'true' : 'false'}
          onChange={(e) => set('active', e.target.value === 'true')}
          className="h-7 text-xs border border-input rounded-md px-2 w-full bg-background"
        >
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Edit form
// ---------------------------------------------------------------------------

function EditForm({
  reason,
  onSaved,
  onCancel,
}: {
  reason: AdjustmentReason
  onSaved: (updated: AdjustmentReason) => void
  onCancel: () => void
}) {
  const [fields, setFields] = useState<FieldState>({
    name: reason.name,
    xeroAccountCode: reason.xeroAccountCode ?? '',
    sortOrder: reason.sortOrder,
    active: reason.active,
  })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    if (!fields.name.trim()) { setError('Name is required'); return }
    setPending(true)
    setError('')
    const result = await updateAdjustmentReason(reason.id, fields)
    setPending(false)
    if (result.success && result.item) {
      onSaved(result.item)
    } else {
      setError(result.message ?? Object.values(result.errors ?? {}).flat()[0] ?? 'Failed to save.')
    }
  }

  return (
    <tr className="border-b border-border last:border-0 bg-muted/30">
      <td colSpan={5} className="py-3 px-2">
        <div className="flex gap-2 items-end">
          <ReasonFields fields={fields} onChange={setFields} error={error} />
          <div className="flex gap-1 pb-0.5">
            <Button type="button" size="icon" disabled={pending} onClick={handleSave} title="Save" className="h-7 w-7">
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" variant="outline" size="icon" onClick={onCancel} title="Cancel" className="h-7 w-7">
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// Display row
// ---------------------------------------------------------------------------

function ReasonRow({
  reason,
  onUpdated,
  onDeleted,
}: {
  reason: AdjustmentReason
  onUpdated: (updated: AdjustmentReason) => void
  onDeleted: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    if (!confirm(`Delete reason "${reason.name}"?`)) return
    setDeleting(true)
    const result = await deleteAdjustmentReason(reason.id)
    if (result.error) {
      alert(result.error)
      setDeleting(false)
    } else {
      onDeleted(reason.id)
    }
  }

  if (editing) {
    return (
      <EditForm
        reason={reason}
        onSaved={(updated) => { onUpdated(updated); setEditing(false) }}
        onCancel={() => setEditing(false)}
      />
    )
  }

  return (
    <tr className="border-b border-border last:border-0">
      <td className="py-2 pr-4 text-sm">{reason.name}</td>
      <td className="py-2 pr-4 text-sm font-mono text-muted-foreground">
        {reason.xeroAccountCode ?? <span className="text-muted-foreground/50">—</span>}
      </td>
      <td className="py-2 pr-4 text-sm text-center">{reason.sortOrder}</td>
      <td className="py-2 pr-4 text-sm text-center">
        <span className={reason.active ? 'text-green-600' : 'text-muted-foreground'}>
          {reason.active ? 'Yes' : 'No'}
        </span>
      </td>
      <td className="py-2 text-right">
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="icon" onClick={() => setEditing(true)} title="Edit">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" onClick={handleDelete} disabled={deleting}
            title="Delete" className="text-destructive hover:text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// Add row
// ---------------------------------------------------------------------------

const emptyFields: FieldState = { name: '', xeroAccountCode: '', sortOrder: 0, active: true }

function AddReasonRow({ onAdded }: { onAdded: (item: AdjustmentReason) => void }) {
  const [open, setOpen] = useState(false)
  const [fields, setFields] = useState<FieldState>(emptyFields)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    if (!fields.name.trim()) { setError('Name is required'); return }
    setPending(true)
    setError('')
    try {
      const result = await createAdjustmentReason(fields)
      setPending(false)
      if (result.success && result.item) {
        onAdded(result.item)
        setFields(emptyFields)
        setOpen(false)
      } else {
        setError(result.message ?? Object.values(result.errors ?? {}).flat()[0] ?? 'Failed to save.')
      }
    } catch (e) {
      setPending(false)
      setError('Failed to save: ' + String(e))
    }
  }

  if (!open) {
    return (
      <tr>
        <td colSpan={5} className="pt-3">
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add Reason
          </Button>
        </td>
      </tr>
    )
  }

  return (
    <tr className="bg-muted/30">
      <td colSpan={5} className="py-3 px-2">
        <div className="flex gap-2 items-end">
          <ReasonFields fields={fields} onChange={setFields} error={error} />
          <div className="flex gap-1 pb-0.5">
            <Button type="button" size="icon" disabled={pending} onClick={handleSave} title="Save" className="h-7 w-7">
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" variant="outline" size="icon" onClick={() => { setOpen(false); setFields(emptyFields) }} title="Cancel" className="h-7 w-7">
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export function AdjustmentReasonsTable({ reasons: initial }: Props) {
  const [reasons, setReasons] = useState(initial)

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-xs text-muted-foreground">
          <th className="pb-2 text-left font-medium">Reason Name</th>
          <th className="pb-2 text-left font-medium">Xero Account Code</th>
          <th className="pb-2 text-center font-medium w-24">Sort</th>
          <th className="pb-2 text-center font-medium w-20">Active</th>
          <th className="pb-2 w-20" />
        </tr>
      </thead>
      <tbody>
        {reasons.length === 0 && (
          <tr>
            <td colSpan={5} className="py-4 text-sm text-muted-foreground text-center">
              No reasons configured yet.
            </td>
          </tr>
        )}
        {reasons.map((r) => (
          <ReasonRow
            key={r.id}
            reason={r}
            onUpdated={(updated) => setReasons((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))}
            onDeleted={(id) => setReasons((prev) => prev.filter((x) => x.id !== id))}
          />
        ))}
        <AddReasonRow onAdded={(item) => setReasons((prev) => [...prev, item])} />
      </tbody>
    </table>
  )
}
