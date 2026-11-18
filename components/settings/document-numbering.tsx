'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  previewDocumentPattern,
  resetDocumentNumberCounter,
  saveDocumentNumberPattern,
  type DocumentNumberingOverview,
  type DocumentNumberingRow,
} from '@/app/actions/document-numbering'

const SCOPE_TEXT: Record<DocumentNumberingRow['scope'], string> = {
  none: 'one counter for ever',
  year: 'the counter starts again each year',
  month: 'the counter starts again each month',
  day: 'the counter starts again each day',
}

function NumberingRow({ row }: { row: DocumentNumberingRow }) {
  const router = useRouter()
  const [pattern, setPattern] = useState(row.storedPattern ?? '')
  const [preview, setPreview] = useState<string | null>(row.nextPreview)
  const [nextNumber, setNextNumber] = useState('')
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [isPending, startTransition] = useTransition()

  const shownDefault = row.defaultPatternText ?? 'not numbered'

  function refreshPreview(value: string) {
    startTransition(async () => {
      const result = await previewDocumentPattern({ type: row.type, pattern: value })
      if (result.success) {
        setPreview(result.nextPreview ?? null)
        setMessage(null)
      } else {
        setPreview(null)
        setMessage({ kind: 'error', text: result.error ?? 'The pattern is not valid.' })
      }
    })
  }

  function savePattern() {
    startTransition(async () => {
      const result = await saveDocumentNumberPattern({ type: row.type, pattern })
      if (result.success) {
        setMessage({ kind: 'ok', text: 'Saved. Documents already numbered keep their numbers.' })
        router.refresh()
      } else {
        setMessage({ kind: 'error', text: result.error ?? 'Could not save the pattern.' })
      }
    })
  }

  function resetCounter() {
    const value = Number.parseInt(nextNumber, 10)
    startTransition(async () => {
      const result = await resetDocumentNumberCounter({ type: row.type, nextNumber: value })
      if (result.success) {
        setMessage({ kind: 'ok', text: `The next number will be ${value}.` })
        setNextNumber('')
        router.refresh()
      } else {
        setMessage({ kind: 'error', text: result.error ?? 'Could not set the counter.' })
      }
    })
  }

  return (
    <div className="py-3 border-b border-border/50 last:border-b-0 space-y-2" data-testid={`numbering-${row.type}`}>
      <div>
        <div className="text-sm font-medium">{row.label}</div>
        <div className="text-[11px] text-muted-foreground">{row.description}</div>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label className="text-xs" htmlFor={`pattern-${row.type}`}>Pattern</Label>
          <Input
            id={`pattern-${row.type}`}
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            onBlur={() => refreshPreview(pattern)}
            className="h-8 w-72 text-xs font-mono"
            placeholder={shownDefault}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Next number</Label>
          <p className="text-xs font-mono pt-1" data-testid={`numbering-preview-${row.type}`}>
            {preview ?? 'No number: documents of this kind carry no reference.'}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={savePattern} disabled={isPending}>
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save pattern
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {row.isDefault
          ? `Using the default (${shownDefault}), which starts with the prefix above. Leave the pattern empty to keep it.`
          : 'Using your pattern. Empty the box and save to go back to the default.'}
      </p>
      {row.usesCounter && (
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Last number issued</Label>
            <p className="text-xs font-mono pt-1">{row.counter} ({SCOPE_TEXT[row.scope]})</p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor={`next-${row.type}`}>Make the next number</Label>
            <Input
              id={`next-${row.type}`}
              inputMode="numeric"
              value={nextNumber}
              onChange={(e) => setNextNumber(e.target.value.replace(/\D/g, ''))}
              className="h-8 w-28 text-xs font-mono"
              placeholder={String(row.highestUsed + 1)}
            />
          </div>
          <Button size="sm" variant="outline" onClick={resetCounter} disabled={isPending || nextNumber === ''}>
            Set next number
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Cannot go back to a number already in use{row.highestUsed > 0 ? ` (highest in use: ${row.highestUsed})` : ''}.
          </p>
        </div>
      )}
      {message && (
        <p className={`text-xs ${message.kind === 'error' ? 'text-destructive' : 'text-emerald-600'}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
    </div>
  )
}

export function DocumentNumberingPanel({ overview }: { overview: DocumentNumberingOverview }) {
  return (
    <Card className="p-6 mt-4" data-testid="document-numbering">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Number patterns</h3>
      <p className="text-sm text-muted-foreground mb-2">
        Set how IMS numbers the documents it creates. Write plain text and these tokens:
        {' '}<code className="font-mono text-xs">{'{YYYY}'}</code> year, <code className="font-mono text-xs">{'{YY}'}</code> two-digit year,
        {' '}<code className="font-mono text-xs">{'{MM}'}</code> month, <code className="font-mono text-xs">{'{DD}'}</code> day,
        {' '}<code className="font-mono text-xs">{'{SEQ}'}</code> the counter as it is, <code className="font-mono text-xs">{'{SEQ:5}'}</code> the counter padded with zeros to 5 digits,
        {' '}<code className="font-mono text-xs">{'{RAND:4}'}</code> four random letters and digits.
        Numbers are never padded unless you write the width.
      </p>
      <p className="text-[11px] text-muted-foreground mb-2">
        A pattern needs <code className="font-mono">{'{SEQ}'}</code> or <code className="font-mono">{'{RAND:n}'}</code>. Changing a pattern never renumbers a document that already exists.
        If the next number is already taken, IMS skips to the next free one.
      </p>
      <div>
        {overview.rows.map((row) => <NumberingRow key={row.type} row={row} />)}
        <div className="py-3 space-y-1" data-testid="numbering-sales-invoice">
          <div className="text-sm font-medium flex items-center gap-2">
            Sales invoice
            <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-0 text-[10px] font-medium bg-muted text-muted-foreground">
              <Lock className="h-3 w-3" aria-hidden /> Owned by {overview.salesInvoice.ownerLabel}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">{overview.salesInvoice.message}</p>
        </div>
      </div>
    </Card>
  )
}
