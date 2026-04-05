import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getHelpDoc, getHelpDocs } from '@/app/actions/help'
import { HelpClient } from './help-client'

export const metadata: Metadata = { title: 'Help' }

type Props = { params: Promise<{ slug: string }> }

export default async function HelpDocPage({ params }: Props) {
  const { slug } = await params
  const [doc, allDocs] = await Promise.all([
    getHelpDoc(slug),
    getHelpDocs(),
  ])

  if (!doc) notFound()

  return <HelpClient doc={doc} allDocs={allDocs} />
}
