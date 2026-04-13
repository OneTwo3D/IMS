'use client'

import { useRef, useState, useTransition } from 'react'
import { Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ImportResult } from '@/app/actions/import'

type Props = {
  label?: string
  action: (formData: FormData) => Promise<ImportResult>
  onDone?: () => void
  compact?: boolean
}

export function CsvImportButton({ label = 'Import CSV', action, onDone, compact = false }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const fd = new FormData()
    fd.append('file', file)
    setResult(null)
    startTransition(async () => {
      const r = await action(fd)
      setResult(r)
      onDone?.()
    })
    // reset so same file can be picked again
    e.target.value = ''
  }

  return (
    <div className="flex flex-col gap-1">
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        onChange={handleChange}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={isPending}
        onClick={() => inputRef.current?.click()}
        className={compact ? 'w-full' : undefined}
      >
        <Upload className="h-4 w-4 mr-1" />
        {isPending ? 'Importing…' : label}
      </Button>

      {result && (
        <div className="text-xs mt-1 rounded border border-border bg-muted p-2 max-w-xs">
          <div className="flex items-start justify-between gap-2">
            <div>
              <span className="text-green-600 font-medium">+{result.created} created</span>
              {result.updated > 0 && (
                <span className="ml-2 text-blue-600 font-medium">{result.updated} updated</span>
              )}
              {result.skipped > 0 && (
                <span className="ml-2 text-muted-foreground">{result.skipped} skipped</span>
              )}
            </div>
            <button
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setResult(null)}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          {result.errors.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-destructive">
              {result.errors.slice(0, 5).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
              {result.errors.length > 5 && (
                <li>…and {result.errors.length - 5} more</li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
