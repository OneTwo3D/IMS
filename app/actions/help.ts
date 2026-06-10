'use server'

import { access, readFile } from 'fs/promises'
import path from 'path'

export type HelpDoc = {
  slug: string
  title: string
  content: string
}

const DOCS_DIR = path.join(process.cwd(), 'help-docs')

const HELP_DOCS = [
  { slug: 'getting-started', title: 'Getting Started' },
  { slug: 'onboarding-walkthrough', title: 'Setup Wizard Walkthrough' },
  { slug: 'glossary', title: 'Glossary' },
  { slug: 'troubleshooting', title: 'Troubleshooting' },
  { slug: 'dashboard', title: 'Dashboard' },
  { slug: 'inventory', title: 'Inventory Management' },
  { slug: 'stock-control', title: 'Stock Control' },
  { slug: 'purchasing', title: 'Purchasing' },
  { slug: 'sales', title: 'Sales Orders' },
  { slug: 'manufacturing', title: 'Manufacturing' },
  { slug: 'analytics', title: 'Analytics & Reports' },
  { slug: 'settings', title: 'Settings' },
  { slug: 'user-management', title: 'User Management & Security' },
  { slug: 'documents-email', title: 'Documents & Email' },
  { slug: 'activity-log', title: 'Activity Log' },
  { slug: 'woocommerce', title: 'WooCommerce Integration' },
  { slug: 'xero-sync', title: 'Xero Accounting Sync' },
] as const

const HELP_SLUGS = new Set(HELP_DOCS.map((doc) => doc.slug))

function extractTitle(content: string, slug: string): string {
  const match = content.match(/^#\s+(.+)$/m)
  return match?.[1] ?? HELP_DOCS.find((doc) => doc.slug === slug)?.title ?? slug
}

export async function getHelpDocs(): Promise<{ slug: string; title: string }[]> {
  const docs = await Promise.all(
    HELP_DOCS.map(async (doc) => {
      try {
        await access(path.join(DOCS_DIR, `${doc.slug}.md`))
        return doc
      } catch {
        return null
      }
    }),
  )
  return docs.filter(Boolean) as { slug: string; title: string }[]
}

export async function getHelpDoc(slug: string): Promise<HelpDoc | null> {
  try {
    const safeName = slug.replace(/[^a-zA-Z0-9-]/g, '')
    if (!HELP_SLUGS.has(safeName as (typeof HELP_DOCS)[number]['slug'])) {
      return null
    }
    const filePath = path.join(DOCS_DIR, `${safeName}.md`)
    const content = await readFile(filePath, 'utf-8')
    return {
      slug: safeName,
      title: extractTitle(content, safeName),
      content,
    }
  } catch {
    return null
  }
}
