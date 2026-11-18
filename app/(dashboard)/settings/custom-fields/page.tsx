import { AccessDenied } from '@/components/auth/access-denied'
import { authorizePage } from '@/lib/auth/server'
import type { Metadata } from 'next'
import { Card } from '@/components/ui/card'
import { listCustomFieldDefinitions } from '@/app/actions/custom-fields'
import { CustomFieldDefinitionsManager } from '@/components/settings/custom-field-definitions'

export const metadata: Metadata = { title: 'Custom Fields' }

export default async function CustomFieldsSettingsPage() {
  // Page-level authorization, the first statement so a denial performs no read (see the other settings pages).
  const gate = await authorizePage('settings.company')
  if (!gate.authorized) return <AccessDenied permission={gate.permission} />

  const definitions = await listCustomFieldDefinitions()

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">Custom Fields</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Add your own typed fields to products and sales orders without a software change. Fields are grouped by the group name you give them.
          Hiding a field removes it from the pages, the CSV and the list filter but keeps every value; showing it again brings them back.
        </p>
      </div>
      <Card className="p-6">
        <CustomFieldDefinitionsManager definitions={definitions} />
      </Card>
    </div>
  )
}
