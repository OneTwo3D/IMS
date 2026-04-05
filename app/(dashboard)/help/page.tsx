import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getHelpDocs } from '@/app/actions/help'

export const metadata: Metadata = { title: 'Help' }

export default async function HelpPage() {
  const docs = await getHelpDocs()
  if (docs.length > 0) {
    redirect(`/help/${docs[0].slug}`)
  }
  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold">Help</h1>
      <p className="mt-2 text-muted-foreground">No documentation files found.</p>
    </div>
  )
}
