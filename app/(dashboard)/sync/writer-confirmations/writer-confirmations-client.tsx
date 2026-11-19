'use client'

import { useState, useTransition } from 'react'
import { confirmWriterStopped, type WriterConfirmationRow } from '@/app/actions/writer-attestation'

export function WriterConfirmationsClient({ rows }: { rows: WriterConfirmationRow[] }) {
  return (
    <div className="space-y-4">
      {rows.map((row) => <ConfirmationCard key={row.kind} row={row} />)}
    </div>
  )
}

function ConfirmationCard({ row }: { row: WriterConfirmationRow }) {
  const [acknowledged, setAcknowledged] = useState(false)
  const [note, setNote] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  return (
    <section className="rounded-md border p-4 space-y-3">
      <h2 className="font-medium">{row.label}</h2>
      <p className="text-sm">
        {row.confirmedAt
          ? `Confirmed ${new Date(row.confirmedAt).toLocaleString()}.`
          : 'Not confirmed. IMS will refuse to switch its own writer on.'}
      </p>
      <p className="text-sm text-muted-foreground">{row.statement}</p>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-1 rounded border-input" />
        <span>I confirm the statement above.</span>
      </label>
      <input
        value={note}
        maxLength={500}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)"
        className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
      />
      <button
        type="button"
        disabled={!acknowledged || pending}
        className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        onClick={() => startTransition(async () => {
          const result = await confirmWriterStopped({ kind: row.kind, note, acknowledged })
          setMessage(result.success ? 'Recorded.' : (result.error ?? 'Could not record the confirmation.'))
          if (result.success) { setAcknowledged(false); setNote('') }
        })}
      >
        {row.confirmedAt ? 'Confirm again' : 'Record confirmation'}
      </button>
      {message ? <p role="status" className="text-sm">{message}</p> : null}
    </section>
  )
}
