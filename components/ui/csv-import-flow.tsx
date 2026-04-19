'use client'

import { useRef, useState, useTransition, type ReactNode } from 'react'
import { AlertTriangle, FileSpreadsheet, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  createCsvImportExecutionResult,
  isCsvImportPreviewResult,
  type CsvImportAction,
  type CsvImportExecutionResult,
  type CsvImportPreviewResult,
} from '@/lib/csv-import'

type TriggerRenderProps = {
  busy: boolean
  openFilePicker: () => void
}

type Props = {
  action?: CsvImportAction
  onDone?: () => void
  children: (props: TriggerRenderProps) => ReactNode
}

function StatCard({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: number
  tone?: 'default' | 'success' | 'warning'
}) {
  const toneClass = tone === 'success'
    ? 'text-green-700 bg-green-50 border-green-200'
    : tone === 'warning'
      ? 'text-orange-700 bg-orange-50 border-orange-200'
      : 'text-foreground bg-muted/40 border-border'

  return (
    <div className={`rounded-lg border p-3 ${toneClass}`}>
      <div className="text-xs uppercase tracking-wide">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  )
}

export function CsvImportFlow({ action, onDone, children }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<CsvImportPreviewResult | null>(null)
  const [result, setResult] = useState<CsvImportExecutionResult | null>(null)
  const [resultFileName, setResultFileName] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function resetInput() {
    if (inputRef.current) inputRef.current.value = ''
  }

  function clearPreview() {
    setPreview(null)
    setSelectedFile(null)
    resetInput()
  }

  function clearResult() {
    setResult(null)
    setResultFileName(null)
  }

  function buildFormData(file: File, mode: 'preview' | 'execute') {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('mode', mode)
    return fd
  }

  function openFilePicker() {
    inputRef.current?.click()
  }

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file || !action) return

    setSelectedFile(file)
    setResult(null)
    setResultFileName(null)
    resetInput()

    startTransition(async () => {
      try {
        const response = await action(buildFormData(file, 'preview'))
        if (isCsvImportPreviewResult(response)) {
          setPreview(response)
          return
        }
        setSelectedFile(null)
        setResultFileName(file.name)
        setResult(response)
        onDone?.()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setSelectedFile(null)
        setResultFileName(file.name)
        setResult(createCsvImportExecutionResult({
          created: 0,
          updated: 0,
          skipped: 0,
          errors: [message],
          error: message,
          success: false,
        }))
      }
    })
  }

  function approveImport() {
    if (!selectedFile || !action) return
    const fileName = selectedFile.name

    startTransition(async () => {
      try {
        const response = await action(buildFormData(selectedFile, 'execute'))
        setPreview(null)
        setSelectedFile(null)
        setResultFileName(fileName)
        setResult(isCsvImportPreviewResult(response)
          ? createCsvImportExecutionResult({
              created: response.created,
              updated: response.updated,
              skipped: response.errorCount,
              errors: response.errors,
              error: response.error,
              success: false,
            })
          : response)
        onDone?.()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setPreview(null)
        setSelectedFile(null)
        setResultFileName(fileName)
        setResult(createCsvImportExecutionResult({
          created: 0,
          updated: 0,
          skipped: 0,
          errors: [message],
          error: message,
          success: false,
        }))
      }
    })
  }

  const validRows = (preview?.created ?? 0) + (preview?.updated ?? 0)
  const resultErrorCount = result?.errors.length ?? 0
  const resultTitle = result?.error && !result?.count
    ? 'Import Failed'
    : resultErrorCount > 0
      ? 'Import Completed With Issues'
      : 'Import Complete'

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={handleChange}
        disabled={!action || isPending}
      />

      {children({ busy: isPending, openFilePicker })}

      <Dialog open={preview !== null} onOpenChange={(open) => { if (!open) clearPreview() }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Review CSV Import</DialogTitle>
            <DialogDescription>
              {selectedFile ? `${selectedFile.name} is ready for review.` : 'Review detected changes before importing.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="CSV Records" value={preview?.totalRows ?? 0} />
              <StatCard label="Will Create" value={preview?.created ?? 0} tone="success" />
              <StatCard label="Will Update" value={preview?.updated ?? 0} />
              <StatCard label="Errors" value={preview?.errorCount ?? 0} tone="warning" />
            </div>

            {preview?.errors.length ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium text-orange-700">
                  <AlertTriangle className="h-4 w-4" />
                  Issues found
                </div>
                <div className="max-h-64 overflow-y-auto rounded-lg border border-orange-200 bg-orange-50/60 p-3">
                  <ul className="space-y-1 text-sm text-orange-900">
                    {preview.errors.map((entry, index) => (
                      <li key={`${index}-${entry}`}>{entry}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                No issues detected. The import is ready to run.
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={clearPreview} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={approveImport} disabled={isPending || validRows === 0}>
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Import {validRows} {validRows === 1 ? 'Record' : 'Records'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={result !== null} onOpenChange={(open) => { if (!open) clearResult() }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{resultTitle}</DialogTitle>
            <DialogDescription>
              Review the final outcome of the CSV import.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Created" value={result?.created ?? 0} tone="success" />
              <StatCard label="Updated" value={result?.updated ?? 0} />
              <StatCard label="Skipped" value={result?.skipped ?? 0} tone="warning" />
              <StatCard label="Errors" value={resultErrorCount} tone="warning" />
            </div>

            {resultFileName && (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                <FileSpreadsheet className="h-4 w-4" />
                {resultFileName}
              </div>
            )}

            {result?.errors.length ? (
              <div className="space-y-2">
                <div className="text-sm font-medium">Import messages</div>
                <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3">
                  <ul className="space-y-1 text-sm">
                    {result.errors.map((entry, index) => (
                      <li key={`${index}-${entry}`}>{entry}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                Import finished without errors.
              </div>
            )}
          </div>

          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </>
  )
}
