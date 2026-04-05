'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Download, Upload, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Props = {
  exportUrl: string
  templateUrl: string
  importAction?: (formData: FormData) => Promise<{ success?: boolean; count?: number; created?: number; updated?: number; error?: string; message?: string; errors?: string[] }>
  extraButtons?: React.ReactNode
}

export function CsvBar({ exportUrl, templateUrl, importAction, extraButtons }: Props) {
  const router = useRouter()
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{ message?: string; error?: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !importAction) return
    setImporting(true)
    setImportResult(null)
    const fd = new FormData()
    fd.append('file', file)
    const result = await importAction(fd)
    setImporting(false)
    const count = result.count ?? ((result.created ?? 0) + (result.updated ?? 0))
    if (result.success || count > 0) {
      const parts: string[] = []
      if (result.created) parts.push(`${result.created} created`)
      if (result.updated) parts.push(`${result.updated} updated`)
      setImportResult({ message: parts.length ? parts.join(', ') : `Imported ${count} rows` })
      router.refresh()
    } else {
      setImportResult({ error: result.error ?? result.errors?.[0] ?? result.message ?? 'Import failed' })
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <a href={templateUrl} className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2.5 h-7 text-xs font-medium hover:bg-muted transition-colors">
        <Download className="h-3 w-3" />Template
      </a>
      <a href={exportUrl} className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2.5 h-7 text-xs font-medium hover:bg-muted transition-colors">
        <Download className="h-3 w-3" />Export CSV
      </a>
      {importAction && (
        <label className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2.5 h-7 text-xs font-medium hover:bg-muted transition-colors cursor-pointer">
          {importing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
          Import CSV
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleImport} disabled={importing} />
        </label>
      )}
      {extraButtons}
      {importResult?.message && <span className="text-xs text-green-600">{importResult.message}</span>}
      {importResult?.error && <span className="text-xs text-destructive">{importResult.error}</span>}
    </div>
  )
}
