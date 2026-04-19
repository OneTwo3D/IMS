'use client'

import { useRouter } from 'next/navigation'
import { Download, Upload, Loader2, Ellipsis } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { CsvImportFlow } from '@/components/ui/csv-import-flow'
import type { CsvImportAction } from '@/lib/csv-import'

type MobileMenuItem = {
  label: string
  href: string
  icon?: React.ComponentType<{ className?: string }>
}

type Props = {
  exportUrl: string
  templateUrl: string
  importAction?: CsvImportAction
  extraButtons?: React.ReactNode
  mobileMenuItems?: MobileMenuItem[]
}

export function CsvBar({ exportUrl, templateUrl, importAction, extraButtons, mobileMenuItems = [] }: Props) {
  const router = useRouter()

  return (
    <CsvImportFlow action={importAction} onDone={() => router.refresh()}>
      {({ busy, openFilePicker }) => (
        <div className="flex flex-wrap items-center gap-2">
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
                onClick={openFilePicker}
                disabled={busy}
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
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
                  <DropdownMenuItem onClick={openFilePicker} disabled={busy}>
                    {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                    Import CSV
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <span className="text-xs text-muted-foreground">Templates include a `# REQUIRED` guidance row. Empty import cells do not overwrite existing values.</span>
        </div>
      )}
    </CsvImportFlow>
  )
}
