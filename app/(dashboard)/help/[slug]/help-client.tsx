'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import Markdown from 'react-markdown'
import { cn } from '@/lib/utils'
import type { HelpDoc } from '@/app/actions/help'

type Props = {
  doc: HelpDoc
  allDocs: { slug: string; title: string }[]
}

export function HelpClient({ doc, allDocs }: Props) {
  const pathname = usePathname()

  return (
    <div className="flex gap-6 max-w-6xl">
      {/* Sidebar nav */}
      <nav className="w-48 shrink-0 space-y-1 sticky top-6 self-start">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Documentation</h2>
        {allDocs.map((d) => {
          const href = `/help/${d.slug}`
          const isActive = pathname === href
          return (
            <Link
              key={d.slug}
              href={href}
              className={cn(
                'block px-3 py-1.5 text-sm rounded-md transition-colors',
                isActive
                  ? 'bg-accent text-accent-foreground font-medium'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {d.title}
            </Link>
          )
        })}
      </nav>

      {/* Content */}
      <article className="flex-1 min-w-0">
        <div className="prose prose-sm dark:prose-invert max-w-none
          prose-headings:font-semibold
          prose-h1:text-2xl prose-h1:mb-4 prose-h1:pb-2 prose-h1:border-b
          prose-h2:text-xl prose-h2:mt-8 prose-h2:mb-3
          prose-h3:text-base prose-h3:mt-6 prose-h3:mb-2
          prose-p:text-sm prose-p:leading-relaxed
          prose-li:text-sm
          prose-code:text-xs prose-code:bg-zinc-900 prose-code:text-zinc-100 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded dark:prose-code:bg-zinc-800 dark:prose-code:text-zinc-200
          prose-pre:bg-zinc-900 prose-pre:text-zinc-100 prose-pre:text-xs prose-pre:rounded-lg prose-pre:p-4 dark:prose-pre:bg-zinc-800 dark:prose-pre:text-zinc-200
          prose-table:text-sm
          prose-th:text-left prose-th:px-3 prose-th:py-2 prose-th:bg-muted/50 prose-th:font-medium prose-th:text-muted-foreground
          prose-td:px-3 prose-td:py-2 prose-td:border-t
          prose-a:text-primary prose-a:no-underline hover:prose-a:underline
          prose-strong:font-semibold
          prose-hr:my-6
        ">
          <Markdown>{doc.content}</Markdown>
        </div>
      </article>
    </div>
  )
}
