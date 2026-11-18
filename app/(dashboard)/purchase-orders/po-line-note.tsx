'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, StickyNote } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { updatePoLineNote } from '@/app/actions/purchase-orders'

/**
 * The notepad on a line: a button that opens a text field under the product. The note is internal (colourway, substitute accepted, chase this one) and is
 * saved with the order; it is never printed on the supplier PO or sent in the supplier email.
 */
export function LineNotesField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const has = value.trim() !== ''
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={has ? 'Edit line note' : 'Add line note'}
        title={has ? 'Internal line note (not sent to the supplier)' : 'Add an internal line note (not sent to the supplier)'}
        className={`inline-flex items-center gap-1 text-xs ${has ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
      >
        <StickyNote className="h-3.5 w-3.5" />{has ? 'Note' : ''}
      </button>
      {open && (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={2000}
          rows={2}
          placeholder="Internal note for this line. Not sent to the supplier."
          aria-label="Line note"
          className="mt-1 block w-full min-w-48 rounded-md border border-input bg-background px-2 py-1 text-xs"
        />
      )}
    </div>
  )
}

/**
 * The internal note on a line, shown under the product. Click the notepad to open a text field and save it on the order. Internal only: it is not printed on the
 * supplier PO PDF and not sent in the supplier email.
 */
export function PoLineNote({ lineId, initial, canEdit }: { lineId: string; initial: string | null; canEdit: boolean }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [saved, setSaved] = useState(initial ?? '')
  const [draft, setDraft] = useState(initial ?? '')
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  if (!canEdit && !saved) return null
  function handleSave() {
    setError('')
    startTransition(async () => {
      const result = await updatePoLineNote(lineId, draft.trim() || null)
      if (result.success) {
        setSaved(result.notes ?? '')
        setDraft(result.notes ?? '')
        setOpen(false)
        router.refresh()
      } else setError(result.error ?? 'Failed to save the note')
    })
  }
  return (
    <div className="mt-1 text-xs" data-testid="po-line-note">
      {canEdit ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={saved ? 'Edit line note' : 'Add line note'}
          title="Internal line note (not sent to the supplier)"
          className={`inline-flex items-center gap-1 ${saved ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
        >
          <StickyNote className="h-3.5 w-3.5" />{saved ? 'Note' : ''}
        </button>
      ) : (
        <span className="inline-flex items-center gap-1 text-primary"><StickyNote className="h-3.5 w-3.5" />Note</span>
      )}
      {saved && !open && <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground" data-testid="po-line-note-text">{saved}</p>}
      {open && (
        <div className="mt-1 space-y-1">
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={2000} rows={2} aria-label="Line note" placeholder="Internal note for this line. Not sent to the supplier." className="text-xs" />
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={handleSave} disabled={isPending}>{isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}Save note</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => { setDraft(saved); setOpen(false); setError('') }} disabled={isPending}>Cancel</Button>
          </div>
          {error && <p className="text-destructive">{error}</p>}
        </div>
      )}
    </div>
  )
}
