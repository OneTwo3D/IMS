'use client'

import { Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CsvImportFlow } from '@/components/ui/csv-import-flow'
import type { CsvImportAction } from '@/lib/csv-import'

type Props = {
  label?: string
  action: CsvImportAction
  onDone?: () => void
  compact?: boolean
}

export function CsvImportButton({ label = 'Import CSV', action, onDone, compact = false }: Props) {
  return (
    <CsvImportFlow action={action} onDone={onDone}>
      {({ busy, openFilePicker }) => (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={openFilePicker}
          className={compact ? 'w-full' : undefined}
        >
          <Upload className="h-4 w-4 mr-1" />
          {busy ? 'Importing…' : label}
        </Button>
      )}
    </CsvImportFlow>
  )
}
