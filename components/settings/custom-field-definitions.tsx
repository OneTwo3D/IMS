'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  createCustomFieldDefinitionAction,
  deleteCustomFieldDefinitionAction,
  updateCustomFieldDefinitionAction,
  type CustomFieldDefinitionListRow,
} from '@/app/actions/custom-fields'
import { CUSTOM_FIELD_TYPES, CUSTOM_FIELD_TYPE_LABELS, type CustomFieldEntityName, type CustomFieldTypeName } from '@/lib/custom-fields/values'

type Draft = {
  namespace: string
  key: string
  label: string
  type: CustomFieldTypeName
  choices: string
  required: boolean
  sortOrder: string
  active: boolean
}

const EMPTY_DRAFT: Draft = { namespace: '', key: '', label: '', type: 'STRING', choices: '', required: false, sortOrder: '0', active: true }

const ENTITY_TITLE: Record<CustomFieldEntityName, string> = { PRODUCT: 'Product fields', SALES_ORDER: 'Sales order fields' }
const ENTITY_HELP: Record<CustomFieldEntityName, string> = {
  PRODUCT: 'Shown on every product and every variant page, and as cf:<key> columns in the product CSV. A variant keeps its own values; nothing is inherited from its parent.',
  SALES_ORDER: 'Shown on every sales order page. A text field with choices, or a yes / no field, can also filter the sales order list. Orders that arrive from the store start with no values.',
}

function toDraft(row: CustomFieldDefinitionListRow): Draft {
  return {
    namespace: row.namespace, key: row.key, label: row.label, type: row.type, choices: (row.options ?? []).join('\n'),
    required: row.required, sortOrder: String(row.sortOrder), active: row.active,
  }
}

const choicesFrom = (text: string): string[] => text.split('\n').map((c) => c.trim()).filter(Boolean)

function DefinitionForm({
  draft, onChange, locked, valueCount, creating,
}: { draft: Draft; onChange: (d: Draft) => void; locked: boolean; valueCount: number; creating: boolean }) {
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => onChange({ ...draft, [k]: v })
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label className="text-xs">Label *</Label>
        <Input className="h-8 text-sm" value={draft.label} onChange={(e) => set('label', e.target.value)} placeholder="e.g. Hazard class" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Group (namespace) *</Label>
        <Input className="h-8 text-sm font-mono" value={draft.namespace} onChange={(e) => set('namespace', e.target.value)} placeholder="e.g. logistics" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Key * {creating ? '' : '(fixed)'}</Label>
        <Input className="h-8 text-sm font-mono" value={draft.key} disabled={!creating} onChange={(e) => set('key', e.target.value)} placeholder="e.g. hazard_class" />
        {creating && <p className="text-[11px] text-muted-foreground">Lower-case letters, digits and underscores. It cannot be changed later: it is the CSV column name (cf:key).</p>}
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Type</Label>
        <select
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
          value={draft.type}
          disabled={locked}
          onChange={(e) => set('type', e.target.value as CustomFieldTypeName)}
        >
          {CUSTOM_FIELD_TYPES.map((t) => <option key={t} value={t}>{CUSTOM_FIELD_TYPE_LABELS[t]}</option>)}
        </select>
        {locked && <p className="text-[11px] text-muted-foreground">{valueCount} value{valueCount === 1 ? '' : 's'} stored, so the type is fixed. Switch this field off and add a new one to change type.</p>}
      </div>
      {draft.type === 'STRING' && (
        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">Choices (one per line; leave empty for free text)</Label>
          <textarea
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
            rows={3}
            value={draft.choices}
            onChange={(e) => set('choices', e.target.value)}
          />
        </div>
      )}
      <div className="space-y-1">
        <Label className="text-xs">Sort order</Label>
        <Input className="h-8 text-sm" inputMode="numeric" value={draft.sortOrder} onChange={(e) => set('sortOrder', e.target.value)} />
      </div>
      <div className="flex items-end gap-4 pb-1">
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" className="accent-primary h-3.5 w-3.5" checked={draft.required} onChange={(e) => set('required', e.target.checked)} />
          Required when saved
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" className="accent-primary h-3.5 w-3.5" checked={draft.active} onChange={(e) => set('active', e.target.checked)} />
          Shown
        </label>
      </div>
    </div>
  )
}

export function CustomFieldDefinitionsManager({ definitions }: { definitions: CustomFieldDefinitionListRow[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [creating, setCreating] = useState<CustomFieldEntityName | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)

  function startCreate(entity: CustomFieldEntityName) {
    setError(null); setEditing(null); setCreating(entity); setDraft(EMPTY_DRAFT)
  }
  function startEdit(row: CustomFieldDefinitionListRow) {
    setError(null); setCreating(null); setEditing(row.id); setDraft(toDraft(row))
  }
  function cancel() { setError(null); setCreating(null); setEditing(null) }

  function saveNew(entity: CustomFieldEntityName) {
    setError(null)
    startTransition(async () => {
      const result = await createCustomFieldDefinitionAction({
        entity, namespace: draft.namespace, key: draft.key, label: draft.label, type: draft.type,
        options: draft.type === 'STRING' ? choicesFrom(draft.choices) : null, required: draft.required, sortOrder: Number(draft.sortOrder),
      })
      if (result.success) { cancel(); router.refresh() } else setError(result.error)
    })
  }

  function saveEdit(row: CustomFieldDefinitionListRow) {
    setError(null)
    startTransition(async () => {
      const result = await updateCustomFieldDefinitionAction({
        id: row.id, namespace: draft.namespace, label: draft.label, type: draft.type,
        options: draft.type === 'STRING' ? choicesFrom(draft.choices) : null, required: draft.required, sortOrder: Number(draft.sortOrder), active: draft.active,
      })
      if (result.success) { cancel(); router.refresh() } else setError(result.error)
    })
  }

  function toggleActive(row: CustomFieldDefinitionListRow) {
    setError(null)
    startTransition(async () => {
      const result = await updateCustomFieldDefinitionAction({
        id: row.id, namespace: row.namespace, label: row.label, type: row.type, options: row.options, required: row.required, sortOrder: row.sortOrder, active: !row.active,
      })
      if (result.success) router.refresh(); else setError(result.error)
    })
  }

  function remove(row: CustomFieldDefinitionListRow) {
    if (!window.confirm(`Delete the field "${row.label}"? This cannot be undone.`)) return
    setError(null)
    startTransition(async () => {
      const result = await deleteCustomFieldDefinitionAction(row.id)
      if (result.success) router.refresh(); else setError(result.error)
    })
  }

  return (
    <div className="space-y-6">
      {error && <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">{error}</p>}
      {(['PRODUCT', 'SALES_ORDER'] as const).map((entity) => {
        const rows = definitions.filter((d) => d.entity === entity)
        const namespaces = [...new Set(rows.map((r) => r.namespace))]
        return (
          <section key={entity} className="space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold">{ENTITY_TITLE[entity]}</h2>
                <p className="text-sm text-muted-foreground">{ENTITY_HELP[entity]}</p>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => startCreate(entity)} disabled={pending}>
                <Plus className="h-3.5 w-3.5 mr-1" />Add field
              </Button>
            </div>
            {creating === entity && (
              <div className="rounded-md border p-3 space-y-3 bg-muted/30">
                <DefinitionForm draft={draft} onChange={setDraft} locked={false} valueCount={0} creating />
                <div className="flex gap-2">
                  <Button type="button" size="sm" onClick={() => saveNew(entity)} disabled={pending}>{pending ? 'Saving…' : 'Create field'}</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={cancel} disabled={pending}>Cancel</Button>
                </div>
              </div>
            )}
            {rows.length === 0 && creating !== entity && <p className="text-sm text-muted-foreground">No fields yet.</p>}
            {namespaces.map((namespace) => (
              <div key={namespace} className="rounded-md border">
                <div className="border-b bg-muted/40 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{namespace.replace(/_/g, ' ')}</div>
                <ul className="divide-y">
                  {rows.filter((r) => r.namespace === namespace).map((row) => (
                    <li key={row.id} className="px-3 py-2">
                      {editing === row.id ? (
                        <div className="space-y-3">
                          <DefinitionForm draft={draft} onChange={setDraft} locked={row.valueCount > 0} valueCount={row.valueCount} creating={false} />
                          <div className="flex gap-2">
                            <Button type="button" size="sm" onClick={() => saveEdit(row)} disabled={pending}>{pending ? 'Saving…' : 'Save'}</Button>
                            <Button type="button" size="sm" variant="ghost" onClick={cancel} disabled={pending}>Cancel</Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between gap-3">
                          <div className={`min-w-0 ${row.active ? '' : 'opacity-60'}`}>
                            <div className="text-sm font-medium">
                              {row.label}{row.required ? ' *' : ''}
                              {!row.active && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal">Hidden</span>}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              <span className="font-mono">cf:{row.key}</span> · {CUSTOM_FIELD_TYPE_LABELS[row.type]}
                              {row.options ? ` · ${row.options.length} choice${row.options.length === 1 ? '' : 's'}` : ''}
                              {` · ${row.valueCount} value${row.valueCount === 1 ? '' : 's'}`}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => toggleActive(row)} disabled={pending}>
                              {row.active ? 'Hide' : 'Show'}
                            </Button>
                            <Button type="button" size="icon" variant="ghost" className="h-7 w-7" title="Edit" onClick={() => startEdit(row)} disabled={pending}>
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button" size="icon" variant="ghost" className="h-7 w-7"
                              title={row.valueCount > 0 ? 'A field that holds values cannot be deleted. Hide it instead.' : 'Delete'}
                              onClick={() => remove(row)} disabled={pending || row.valueCount > 0}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )
      })}
    </div>
  )
}
