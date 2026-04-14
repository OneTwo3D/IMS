'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Download, Upload, Loader2, Ellipsis } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

type MobileMenuItem = {
  label: string
  href: string
  icon?: React.ComponentType<{ className?: string }>
}

type Props = {
  exportUrl: string
  templateUrl: string
  importAction?: (formData: FormData) => Promise<{ success?: boolean; count?: number; created?: number; updated?: number; error?: string; message?: string; errors?: string[] }>
  extraButtons?: React.ReactNode
  mobileMenuItems?: MobileMenuItem[]
}

export function CsvBar({ exportUrl, templateUrl, importAction, extraButtons, mobileMenuItems = [] }: Props) {
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
      <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleImport} disabled={importing} />

      <div className="hidden sm:flex sm:flex-wrap sm:items-center sm:gap-2">
        <a href={templateUrl} className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2.5 h-7 text-xs font-medium hover:bg-muted transition-colors">
          <Download className="h-3 w-3" />Template
        </a>
        <a href={exportUrl} className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2.5 h-7 text-xs font-medium hover:bg-muted transition-colors">
          <Download className="h-3 w-3" />Export CSV
        </a>
        {importAction && (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2.5 h-7 text-xs font-medium hover:bg-muted transition-colors cursor-pointer"
            onClick={() => fileRef.current?.click()}
            disabled={importing}
          >
            {importing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
            Import CSV
          </button>
        )}
        {extraButtons}
      </div>

      <div className="sm:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="outline" size="sm" className="h-8" aria-label="CSV actions" />}
          >
            <Ellipsis className="h-4 w-4" />
            CSV
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuItem onClick={() => window.location.assign(templateUrl)}>
              <Download className="mr-2 h-4 w-4" />
              Template
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => window.location.assign(exportUrl)}>
              <Download className="mr-2 h-4 w-4" />
              Export CSV
            </DropdownMenuItem>
            {mobileMenuItems.map((item) => {
              const Icon = item.icon ?? Download
              return (
                <DropdownMenuItem key={item.href} onClick={() => window.location.assign(item.href)}>
                  <Icon className="mr-2 h-4 w-4" />
                  {item.label}
                </DropdownMenuItem>
              )
            })}
            {importAction && (
              <DropdownMenuItem onClick={() => fileRef.current?.click()} disabled={importing}>
                {importing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                Import CSV
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {importResult?.message && <span className="text-xs text-green-600">{importResult.message}</span>}
      {importResult?.error && <span className="text-xs text-destructive">{importResult.error}</span>}
    </div>
  )
}
