'use client'

import Link from 'next/link'
import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type NavLink = { href: string; label: string }
type NavHeading = { heading: string }
export type NavChild = NavLink | NavHeading

function isLink(c: NavChild): c is NavLink {
  return 'href' in c
}

interface NavGroupProps {
  label: string
  icon: LucideIcon
  items: NavChild[]
  collapsed?: boolean
  onExpand?: () => void
  onNavigate?: () => void
}

export function NavGroup({ label, icon: Icon, items, collapsed, onExpand, onNavigate }: NavGroupProps) {
  const pathname = usePathname()
  const linkItems = items.filter(isLink)
  const isChildActive = (c: NavLink) =>
    pathname === c.href || (pathname.startsWith(c.href + '/') && !linkItems.some((other) => other.href !== c.href && pathname.startsWith(other.href)))
  const isAnyChildActive = linkItems.some(isChildActive)
  // The group auto-opens when it contains the active route, but an explicit user
  // toggle must win — otherwise being on a child route force-opens the group and
  // the collapse click does nothing. `userOpen` (null until the user clicks)
  // overrides the active-derived default.
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? isAnyChildActive

  const parentClass = cn(
    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer select-none',
    'hover:bg-accent hover:text-accent-foreground',
    isAnyChildActive ? 'text-accent-foreground' : 'text-muted-foreground',
    collapsed && 'justify-center px-2',
  )

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={parentClass}
              onClick={() => {
                setUserOpen(true)
                onExpand?.()
              }}
              aria-label={`Expand ${label}`}
            />
          }
        >
          <Icon className="h-4 w-4 shrink-0" />
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <div>
      <button
        type="button"
        className={cn(parentClass, 'w-full')}
        onClick={() => setUserOpen(!open)}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="truncate flex-1 text-left">{label}</span>
        <ChevronDown
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="ml-4 mt-0.5 flex flex-col gap-0.5 border-l border-border pl-3">
          {renderItems(items, isChildActive, onNavigate)}
        </div>
      )}
    </div>
  )
}

type Section = { heading: string | null; links: NavLink[] }

function groupIntoSections(items: NavChild[]): Section[] {
  const sections: Section[] = []
  let current: Section | null = null
  for (const item of items) {
    if (isLink(item)) {
      if (!current) {
        current = { heading: null, links: [] }
        sections.push(current)
      }
      current.links.push(item)
    } else {
      current = { heading: item.heading, links: [] }
      sections.push(current)
    }
  }
  return sections
}

function renderItems(
  items: NavChild[],
  isChildActive: (c: NavLink) => boolean,
  onNavigate?: () => void,
) {
  const sections = groupIntoSections(items)
  const hasHeadings = sections.some((s) => s.heading !== null)
  if (!hasHeadings) {
    return sections.flatMap((s) =>
      s.links.map((link) => (
        <ChildLink key={link.href} link={link} isActive={isChildActive(link)} onNavigate={onNavigate} />
      )),
    )
  }
  return sections.map((section, idx) =>
    section.heading === null ? (
      <div key={`pre-${idx}`} className="flex flex-col gap-0.5">
        {section.links.map((link) => (
          <ChildLink key={link.href} link={link} isActive={isChildActive(link)} onNavigate={onNavigate} />
        ))}
      </div>
    ) : (
      <CollapsibleSection
        key={`section-${idx}-${section.heading}`}
        heading={section.heading}
        links={section.links}
        isChildActive={isChildActive}
        onNavigate={onNavigate}
      />
    ),
  )
}

function ChildLink({ link, isActive, onNavigate }: { link: NavLink; isActive: boolean; onNavigate?: () => void }) {
  return (
    <Link
      href={link.href}
      onClick={onNavigate}
      className={cn(
        'rounded-md px-2 py-1.5 text-sm transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        isActive ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground',
      )}
    >
      {link.label}
    </Link>
  )
}

function CollapsibleSection({
  heading,
  links,
  isChildActive,
  onNavigate,
}: {
  heading: string
  links: NavLink[]
  isChildActive: (c: NavLink) => boolean
  onNavigate?: () => void
}) {
  const hasActiveLink = links.some(isChildActive)
  // User toggle overrides the active-derived default (see NavGroup) so a section
  // containing the active route can still be collapsed.
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? hasActiveLink
  return (
    <div className="mt-2 first:mt-0">
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-semibold transition-colors select-none cursor-pointer',
          'hover:text-foreground',
          hasActiveLink ? 'text-foreground' : 'text-muted-foreground',
        )}
        aria-expanded={open}
      >
        <ChevronDown
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open ? 'rotate-0' : '-rotate-90')}
        />
        <span className="truncate text-left">{heading}</span>
      </button>
      {open && (
        <div className="mt-0.5 flex flex-col gap-0.5 pl-5">
          {links.map((link) => (
            <ChildLink key={link.href} link={link} isActive={isChildActive(link)} onNavigate={onNavigate} />
          ))}
        </div>
      )}
    </div>
  )
}
