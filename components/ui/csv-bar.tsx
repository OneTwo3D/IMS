'use client'

import { useRouter } from 'next/navigation'
import { Download, Upload, Loader2, Menu } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { CsvImportFlow } from '@/components/ui/csv-import-flow'
import type { CsvImportAction } from '@/lib/csv-import'

type Props = {
  exportUrl: string
  templateUrl: string
  importAction?: CsvImportAction
}

export function CsvBar({ exportUrl, templateUrl, importAction }: Props) {
  const router = useRouter()

  return (
    <CsvImportFlow action={importAction} onDone={() => router.refresh()}>
      {({ busy, openFilePicker }) => (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="outline" size="sm" className="h-8" aria-label="CSV actions" />}
          >
            <Menu className="h-4 w-4" />
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
            {importAction && (
              <DropdownMenuItem onClick={openFilePicker} disabled={busy}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                Import CSV
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </CsvImportFlow>
  )
}
