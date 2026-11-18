'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ListPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { saveCustomFieldValues } from '@/app/actions/custom-fields'
import type { CustomFieldCardData, CustomFieldCardField } from '@/lib/custom-fields/values-service'

/** The value as the input shows it: a date-time is shown to the minute, in UTC, the way the server reads it back. */
function toInputText(field: CustomFieldCardField): string {
  if (field.value == null) return ''
  if (field.type === 'DATETIME') return field.value.slice(0, 16)
  return field.value
}

function namespaceTitle(namespace: string): string {
  return namespace.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

export function CustomFieldsCard({ data, canEdit, note }: { data: CustomFieldCardData; canEdit: boolean; note?: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(data.fields.map((f) => [f.id, toInputText(f)])))
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  if (data.fields.length === 0) return null

  const changed = data.fields.filter((f) => (values[f.id] ?? '') !== toInputText(f))

  function save() {
    setMessage(null)
    setFieldErrors({})
    startTransition(async () => {
      const result = await saveCustomFieldValues(data.entity, data.entityId, Object.fromEntries(changed.map((f) => [f.id, values[f.id] ?? ''])))
      if (result.success) {
        setMessage({ tone: 'ok', text: result.changed === 0 ? 'No changes to save.' : `Saved ${result.changed} change${result.changed === 1 ? '' : 's'}.` })
        router.refresh()
      } else {
        setFieldErrors(result.fieldErrors)
        setMessage({ tone: 'error', text: result.error })
      }
    })
  }

  const namespaces = [...new Set(data.fields.map((f) => f.namespace))]
  const set = (id: string, value: string) => setValues((prev) => ({ ...prev, [id]: value }))

  function renderInput(field: CustomFieldCardField) {
    const value = values[field.id] ?? ''
    const common = {
      id: `cf-${field.id}`,
      disabled: !canEdit || pending,
      'aria-invalid': fieldErrors[field.id] ? true : undefined,
      title: fieldErrors[field.id],
    }
    if (field.type === 'STRING' && field.options) {
      return (
        <select {...common} className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={value} onChange={(e) => set(field.id, e.target.value)}>
          <option value="">—</option>
          {/* A stored value that is no longer a choice stays visible rather than silently vanishing. */}
          {value && !field.options.includes(value) && <option value={value}>{value}</option>}
          {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      )
    }
    if (field.type === 'BOOLEAN') {
      return (
        <select {...common} className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={value} onChange={(e) => set(field.id, e.target.value)}>
          <option value="">—</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      )
    }
    if (field.type === 'JSON') {
      return <textarea {...common} rows={3} className="w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs" value={value} onChange={(e) => set(field.id, e.target.value)} />
    }
    if (field.type === 'DATE') return <Input {...common} type="date" className="h-8 text-sm" value={value} onChange={(e) => set(field.id, e.target.value)} />
    if (field.type === 'DATETIME') return <Input {...common} type="datetime-local" className="h-8 text-sm" value={value} onChange={(e) => set(field.id, e.target.value)} />
    if (field.type === 'NUMBER' || field.type === 'DECIMAL') return <Input {...common} inputMode="decimal" className="h-8 text-right font-mono text-sm" value={value} onChange={(e) => set(field.id, e.target.value)} />
    if (field.type === 'LINK') {
      return (
        <div className="space-y-1">
          <Input {...common} type="url" className="h-8 text-sm" placeholder="https://" value={value} onChange={(e) => set(field.id, e.target.value)} />
          {!canEdit && field.value && <a href={field.value} target="_blank" rel="noopener noreferrer" className="text-xs text-primary underline break-all">{field.value}</a>}
        </div>
      )
    }
    return <Input {...common} className="h-8 text-sm" value={value} onChange={(e) => set(field.id, e.target.value)} />
  }

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold flex items-center gap-2 mb-1">
        <ListPlus className="h-4 w-4" />
        Custom fields
      </h2>
      <p className="text-xs text-muted-foreground mb-3">
        Internal fields set up in Settings &gt; Custom fields. They are not sent to the store, the warehouse or the accounting system.
        {note ? ` ${note}` : ''}
      </p>
      <div className="space-y-4">
        {namespaces.map((namespace) => (
          <div key={namespace}>
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1.5">{namespaceTitle(namespace)}</h3>
            <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
              {data.fields.filter((f) => f.namespace === namespace).map((field) => (
                <div key={field.id} className={field.type === 'JSON' ? 'sm:col-span-2' : undefined}>
                  <label htmlFor={`cf-${field.id}`} className="mb-0.5 block text-xs text-muted-foreground">
                    {field.label}{field.required ? ' *' : ''}
                    {field.type === 'DATETIME' ? ' (UTC)' : ''}
                  </label>
                  {renderInput(field)}
                  {fieldErrors[field.id] && <p className="mt-0.5 text-[11px] text-destructive">{fieldErrors[field.id]}</p>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {canEdit ? (
        <div className="mt-3 flex items-center gap-3">
          <Button type="button" size="sm" onClick={save} disabled={pending || changed.length === 0}>{pending ? 'Saving…' : 'Save custom fields'}</Button>
          {message && <span className={`text-xs ${message.tone === 'ok' ? 'text-muted-foreground' : 'text-destructive'}`} role="status">{message.text}</span>}
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">You do not have permission to change these.</p>
      )}
    </Card>
  )
}
