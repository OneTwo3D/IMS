import type { Metadata } from 'next'
import { getWriterConfirmations } from '@/app/actions/writer-attestation'
import { WriterConfirmationsClient } from './writer-confirmations-client'

export const metadata: Metadata = { title: 'Owner confirmations' }
export const dynamic = 'force-dynamic'

export default async function WriterConfirmationsPage() {
  const rows = await getWriterConfirmations()
  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-lg font-semibold">Owner confirmations</h1>
        <p className="text-sm text-muted-foreground">
          IMS does not start writing where another system still writes until the owner says that system is stopped. Each confirmation is recorded with your name and the time,
          and cannot be edited. Administrators only.
        </p>
      </div>
      <WriterConfirmationsClient rows={rows} />
    </div>
  )
}
