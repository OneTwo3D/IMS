import type { Metadata } from 'next'
import { FileText } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { getSetting } from '@/app/actions/settings'
import { InvoiceTriggerSetting } from '@/components/settings/invoice-trigger'

export const metadata: Metadata = { title: 'Sales Settings' }

export default async function SalesSettingsPage() {
  const invoiceTrigger = await getSetting('invoice_trigger')

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">Sales Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Invoice generation and sales order configuration.</p>
      </div>

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Invoice Generation</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Configure when sales order invoices are automatically generated.
        </p>
        <InvoiceTriggerSetting currentValue={invoiceTrigger ?? 'manual'} />
      </Card>
    </div>
  )
}
