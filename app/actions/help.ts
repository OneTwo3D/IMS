'use server'

import { readFile, readdir } from 'fs/promises'
import path from 'path'

export type HelpDoc = {
  slug: string
  title: string
  content: string
}

const DOCS_DIR = path.join(process.cwd(), 'docs')

const TITLE_MAP: Record<string, string> = {
  'user-guide': 'User Guide',
  'architecture': 'Architecture',
  'configuration': 'Configuration',
  'development': 'Development',
  'deployment': 'Deployment',
}

const DOC_ORDER = ['user-guide', 'architecture', 'configuration', 'development', 'deployment']

function extractTitle(content: string, slug: string): string {
  const match = content.match(/^#\s+(.+)$/m)
  return match?.[1] ?? TITLE_MAP[slug] ?? slug
}

export async function getHelpDocs(): Promise<{ slug: string; title: string }[]> {
  try {
    const files = await readdir(DOCS_DIR)
    const docs = files
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const slug = f.replace('.md', '')
        return { slug, title: TITLE_MAP[slug] ?? slug }
      })
      .sort((a, b) => {
        const ai = DOC_ORDER.indexOf(a.slug)
        const bi = DOC_ORDER.indexOf(b.slug)
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
      })
    return docs
  } catch {
    return []
  }
}

export async function getHelpDoc(slug: string): Promise<HelpDoc | null> {
  try {
    const safeName = slug.replace(/[^a-zA-Z0-9-]/g, '')
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
